import { readFile, readlink } from 'node:fs/promises'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { LSOF_NONBLOCKING_ARGS } from '../../shared/process-observation/lsof-nonblocking-args'
import { getProcessOutputFields } from '../../shared/process-observation/process-output-field-scanner'
import { readWindowsProcessTable } from '../windows/windows-process-table'
import { runPortScanCommand } from './port-scan-command-client'
import { parseDarwinNetstatListeners } from './darwin-netstat-listeners'
import { loadDarwinProcessMetadata } from './darwin-process-metadata'
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
import { dedupeRawPorts, parseAddressWithPort } from './local-workspace-port-address'
import { parseProcNetTcp, type ProcNetListener } from './linux-proc-net-listeners'
import { resolveLinuxSocketOwners } from './linux-socket-owners'

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

export async function scanPlatformListeningPorts(
  options: WorkspacePortScanOptions
): Promise<PlatformListeningPortScan> {
  const scan = await dispatchPlatformListeningPortScan(options)
  if (scan.metadataAvailable) {
    rememberListenerMetadata(scan.ports)
    return scan
  }
  return process.platform === 'darwin'
    ? scan
    : { ...scan, ports: scan.ports.map(recallListenerMetadata) }
}

async function dispatchPlatformListeningPortScan(
  options: WorkspacePortScanOptions
): Promise<PlatformListeningPortScan> {
  if (process.platform === 'linux') {
    return scanLinuxProcPorts(options)
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
  const listeners = options.requireMetadata
    ? null
    : await runPortScanCommand('/usr/sbin/netstat', ['-aln', '-p', 'tcp'], 'listeners').catch(
        () => null
      )
  try {
    const { stdout, spawnMs } = await runPortScanCommand(
      '/usr/sbin/lsof',
      [
        '-O',
        ...LSOF_NONBLOCKING_ARGS,
        '-nP',
        '-iTCP',
        '-sTCP:LISTEN',
        '-F',
        // Socket identity distinguishes PID reuse on the same port for metadata caching.
        'pcnd'
      ],
      'attribution'
    )
    const ports = parseLsofListeningOutput(stdout)
    if (shouldSkipMetadataCommands(spawnMs, options)) {
      return { ports: ports.map(recallListenerMetadata), metadataAvailable: false }
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
  } catch (error) {
    if (options.requireMetadata || !listeners) {
      throw error
    }
    return { ports: parseDarwinNetstatListeners(listeners.stdout), metadataAvailable: false }
  }
}

async function scanWindowsNetstatPorts(
  options: WorkspacePortScanOptions
): Promise<PlatformListeningPortScan> {
  const { stdout, spawnMs } = await runPortScanCommand(windowsSystem32Binary('netstat.exe'), [
    '-ano',
    '-p',
    'tcp'
  ])
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

async function scanLinuxProcPorts(
  options: WorkspacePortScanOptions
): Promise<PlatformListeningPortScan> {
  const ownUid = process.getuid?.()
  const [tcp4, tcp6] = await Promise.all([
    readProcNet('/proc/net/tcp', ownUid),
    readProcNet('/proc/net/tcp6', ownUid)
  ])
  const sockets = [...tcp4, ...tcp6]
  const inodeToPid = await resolveLinuxSocketOwners(
    new Set(sockets.map((socket) => socket.inode)),
    {
      requireFresh: options.requireMetadata
    }
  )
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
  filePath: string,
  ownUid: number | undefined
): Promise<ProcNetListener[]> {
  try {
    return parseProcNetTcp(await readFile(filePath, 'utf-8'), ownUid)
  } catch {
    return []
  }
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
