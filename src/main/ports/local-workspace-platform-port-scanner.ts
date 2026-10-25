import { readFile, readdir, readlink } from 'node:fs/promises'
import { LSOF_NONBLOCKING_ARGS } from '../../shared/lsof-nonblocking-args'
import { getProcessOutputFields } from '../../shared/process-output-field-scanner'
import { readWindowsProcessTable } from '../windows/windows-process-table'
import { runPortScanCommand } from './port-scan-command-client'
import {
  partitionListenersNeedingMetadata,
  recallListenerMetadata,
  rememberListenerMetadata,
  shouldSkipMetadataCommands,
  type PlatformListeningPortScan,
  type ProcessMetadata,
  type RawListeningPort,
  type WorkspacePortScanOptions
} from './local-workspace-port-scan-state'
import {
  dedupeRawPorts,
  parseAddressWithPort,
  parseProcAddress
} from './local-workspace-port-address'

export function parseLsofListeningOutput(output: string): RawListeningPort[] {
  const ports: RawListeningPort[] = []
  let pid: number | undefined
  let processName: string | undefined
  let socketId: string | undefined

  for (const line of output.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const parsedPid = Number.parseInt(value, 10)
      pid = Number.isFinite(parsedPid) ? parsedPid : undefined
      processName = socketId = undefined
    } else if (tag === 'c') {
      processName = value
    } else if (tag === 'f') {
      socketId = undefined // A file record lacking d must not inherit the preceding socket identity.
    } else if (tag === 'd') {
      socketId = value || undefined
    } else if (tag === 'n') {
      const parsed = parseAddressWithPort(value)
      if (parsed) {
        ports.push({ pid, processName, ...(socketId ? { socketId } : {}), ...parsed })
      }
    }
  }

  return dedupeRawPorts(ports)
}

export function parseNetstatListeningOutput(output: string): RawListeningPort[] {
  const ports: RawListeningPort[] = []
  for (const line of output.split('\n')) {
    const fields = getProcessOutputFields(line, 6)
    if (fields[0]?.toUpperCase() !== 'TCP') {
      continue
    }
    const stateIndex = fields.findIndex((field) => field.toUpperCase() === 'LISTENING')
    if (stateIndex < 2) {
      continue
    }
    const parsed = parseAddressWithPort(fields[1])
    const pid = Number.parseInt(fields[stateIndex + 1] ?? '', 10)
    if (!parsed) {
      continue
    }
    ports.push({ ...parsed, pid: Number.isFinite(pid) ? pid : undefined })
  }
  return dedupeRawPorts(ports)
}

export function parseProcNetTcp(content: string): { host: string; port: number; inode: number }[] {
  const results: { host: string; port: number; inode: number }[] = []
  const lines = content.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const fields = getProcessOutputFields(lines[i], 10)
    if (fields.length < 10 || fields[3] !== '0A') {
      continue
    }
    const parsed = parseProcAddress(fields[1])
    const inode = Number.parseInt(fields[9], 10)
    if (!parsed || !Number.isFinite(inode) || inode === 0) {
      continue
    }
    results.push({ ...parsed, inode })
  }
  return results
}

export async function scanPlatformListeningPorts(
  options: WorkspacePortScanOptions
): Promise<PlatformListeningPortScan> {
  const scan = await dispatchPlatformListeningPortScan(options)
  if (scan.metadataAvailable) {
    rememberListenerMetadata(scan.ports)
    return scan
  }
  return { ...scan, ports: scan.ports.map(recallListenerMetadata) }
}

async function dispatchPlatformListeningPortScan(
  options: WorkspacePortScanOptions
): Promise<PlatformListeningPortScan> {
  if (process.platform === 'linux') {
    return scanLinuxProcPorts()
  }
  if (process.platform === 'darwin') {
    return scanDarwinLsofPorts(options)
  }
  if (process.platform === 'win32') {
    return scanWindowsNetstatPorts(options)
  }
  throw new Error(`Port scanning is not supported on ${process.platform}`)
}

async function scanDarwinLsofPorts(
  options: WorkspacePortScanOptions
): Promise<PlatformListeningPortScan> {
  const { stdout, spawnMs } = await runPortScanCommand('lsof', [
    ...LSOF_NONBLOCKING_ARGS,
    '-nP',
    '-iTCP',
    '-sTCP:LISTEN',
    '-F',
    // Socket identity distinguishes PID reuse on the same port for metadata caching.
    'pcnd'
  ])
  const ports = parseLsofListeningOutput(stdout)
  if (shouldSkipMetadataCommands(spawnMs, options)) {
    return { ports, metadataAvailable: false }
  }
  // Reuse unchanged listener metadata to avoid the two expensive follow-up commands.
  const { hydrated, pidsNeedingMetadata } = partitionListenersNeedingMetadata(ports, options)
  if (pidsNeedingMetadata.size === 0) {
    return { ports: hydrated, metadataAvailable: true }
  }
  const metadata = await loadDarwinProcessMetadata(pidsNeedingMetadata)
  return {
    ports: hydrated.map((port) => ({ ...metadata.get(port.pid ?? -1), ...port })),
    metadataAvailable: true
  }
}

async function scanWindowsNetstatPorts(
  options: WorkspacePortScanOptions
): Promise<PlatformListeningPortScan> {
  const { stdout, spawnMs } = await runPortScanCommand('netstat', ['-ano', '-p', 'tcp'])
  const ports = parseNetstatListeningOutput(stdout)
  if (shouldSkipMetadataCommands(spawnMs, options)) {
    return { ports, metadataAvailable: false }
  }
  const metadata = await loadWindowsProcessMetadata(
    new Set(ports.flatMap((p) => (p.pid ? [p.pid] : [])))
  )
  return {
    ports: ports.map((port) => ({ ...metadata.get(port.pid ?? -1), ...port })),
    metadataAvailable: true
  }
}

async function scanLinuxProcPorts(): Promise<PlatformListeningPortScan> {
  const [tcp4, tcp6] = await Promise.all([
    readProcNet('/proc/net/tcp'),
    readProcNet('/proc/net/tcp6')
  ])
  const sockets = [...tcp4, ...tcp6]
  const inodeToPid = await mapLinuxInodesToPids(new Set(sockets.map((socket) => socket.inode)))
  const metadata = new Map<number, ProcessMetadata>()
  const rawPorts: RawListeningPort[] = []

  for (const socket of sockets) {
    const pid = inodeToPid.get(socket.inode)
    if (pid != null && !metadata.has(pid)) {
      metadata.set(pid, await loadLinuxProcessMetadata(pid))
    }
    rawPorts.push({
      host: socket.host,
      port: socket.port,
      pid,
      ...metadata.get(pid ?? -1)
    })
  }

  return { ports: dedupeRawPorts(rawPorts), metadataAvailable: true }
}

async function readProcNet(
  filePath: string
): Promise<{ host: string; port: number; inode: number }[]> {
  try {
    return parseProcNetTcp(await readFile(filePath, 'utf-8'))
  } catch {
    return []
  }
}

async function mapLinuxInodesToPids(inodes: Set<number>): Promise<Map<number, number>> {
  const result = new Map<number, number>()
  if (inodes.size === 0) {
    return result
  }
  let pids: string[]
  try {
    pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))
  } catch {
    return result
  }

  for (const pidText of pids) {
    let fds: string[]
    try {
      fds = await readdir(`/proc/${pidText}/fd`)
    } catch {
      continue
    }
    const pid = Number.parseInt(pidText, 10)
    for (const fd of fds) {
      let link: string
      try {
        link = await readlink(`/proc/${pidText}/fd/${fd}`)
      } catch {
        continue
      }
      const match = link.match(/^socket:\[(\d+)\]$/)
      if (!match) {
        continue
      }
      const inode = Number.parseInt(match[1], 10)
      if (inodes.has(inode)) {
        result.set(inode, pid)
      }
    }
  }
  return result
}

async function loadLinuxProcessMetadata(pid: number): Promise<ProcessMetadata> {
  const [comm, cmdline, cwd] = await Promise.all([
    readTextIfAvailable(`/proc/${pid}/comm`),
    readTextIfAvailable(`/proc/${pid}/cmdline`),
    readlink(`/proc/${pid}/cwd`).catch(() => undefined)
  ])
  return {
    processName: comm?.trim() || undefined,
    commandLine: cmdline?.split('\u0000').join(' ').trim() || undefined,
    cwd
  }
}

async function loadDarwinProcessMetadata(pids: Set<number>): Promise<Map<number, ProcessMetadata>> {
  const result = new Map<number, ProcessMetadata>()
  const pidList = Array.from(pids).join(',')
  if (!pidList) {
    return result
  }

  // The worker dispatches serially; concurrent commands would only queue (#11161).
  const cwdOutput = await runPortScanCommand('lsof', [
    ...LSOF_NONBLOCKING_ARGS,
    '-a',
    '-p',
    pidList,
    '-d',
    'cwd',
    '-Fn'
  ]).catch(() => null)
  const commandOutput = await runPortScanCommand('ps', [
    '-p',
    pidList,
    '-o',
    'pid=',
    '-o',
    'command='
  ]).catch(() => null)

  let currentPid: number | null = null
  for (const line of cwdOutput?.stdout.split('\n') ?? []) {
    if (line.startsWith('p')) {
      const pid = Number.parseInt(line.slice(1), 10)
      currentPid = Number.isFinite(pid) ? pid : null
    } else if (line.startsWith('n') && currentPid != null) {
      result.set(currentPid, { ...result.get(currentPid), cwd: line.slice(1) || undefined })
    }
  }

  for (const line of commandOutput?.stdout.split('\n') ?? []) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) {
      continue
    }
    const pid = Number.parseInt(match[1], 10)
    result.set(pid, { ...result.get(pid), commandLine: match[2].trim() || undefined })
  }

  return result
}

async function loadWindowsProcessMetadata(
  pids: Set<number>
): Promise<Map<number, ProcessMetadata>> {
  const result = new Map<number, ProcessMetadata>()
  if (pids.size === 0) {
    return result
  }
  try {
    // Native snapshots avoid ~700ms PowerShell startup, visible conhost windows and Group Policy failures.
    for (const row of await readWindowsProcessTable()) {
      if (pids.has(row.pid)) {
        result.set(row.pid, {
          processName: row.name,
          commandLine: row.command || undefined
        })
      }
    }
  } catch {
    // Process metadata is optional; port rows still render without attribution.
  }
  return result
}

async function readTextIfAvailable(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return undefined
  }
}
