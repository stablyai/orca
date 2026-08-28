import { readFile, readdir, readlink } from 'node:fs/promises'
import { getProcessOutputFields } from '../../shared/process-output-field-scanner'
import { readWindowsProcessTable } from '../windows/windows-process-table'
import { runPortScanCommand } from './port-scan-command-client'
import {
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
  let currentPid: number | undefined
  let currentProcessName: string | undefined

  for (const line of output.split('\n')) {
    if (!line) {
      continue
    }
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const pid = Number.parseInt(value, 10)
      currentPid = Number.isFinite(pid) ? pid : undefined
      currentProcessName = undefined
    } else if (tag === 'c') {
      currentProcessName = value
    } else if (tag === 'n') {
      const parsed = parseAddressWithPort(value)
      if (parsed) {
        ports.push({ pid: currentPid, processName: currentProcessName, ...parsed })
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
    '-nP',
    '-iTCP',
    '-sTCP:LISTEN',
    '-F',
    'pcn'
  ])
  const ports = parseLsofListeningOutput(stdout)
  if (shouldSkipMetadataCommands(spawnMs, options)) {
    return { ports, metadataAvailable: false }
  }
  const metadata = await loadDarwinProcessMetadata(
    new Set(ports.flatMap((p) => (p.pid ? [p.pid] : [])))
  )
  return {
    ports: ports.map((port) => ({ ...metadata.get(port.pid ?? -1), ...port })),
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

  // Why (#11161): sequential, not Promise.all — the probe worker dispatches one
  // command at a time, so issuing both at once would only queue the second.
  const cwdOutput = await runPortScanCommand('lsof', [
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
    // Why the native snapshot: attributing ports used to fork a powershell.exe
    // per scan just to turn PIDs into names. That is a ~700ms cold start, a
    // conhost window, and one more thing a Group Policy can block -- for data
    // the panel treats as optional anyway.
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
