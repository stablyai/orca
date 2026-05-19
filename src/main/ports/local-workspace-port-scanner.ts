/* eslint-disable max-lines -- Why: the platform-specific scan paths share parsing,
attribution, and normalization rules that must stay in lockstep. */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, readdir, readlink } from 'fs/promises'
import path from 'path'
import type {
  WorkspacePort,
  WorkspacePortOwner,
  WorkspacePortProbe,
  WorkspacePortScanResult
} from '../../shared/workspace-ports'

const execFileAsync = promisify(execFile)

const COMMAND_TIMEOUT_MS = 4_000
const MAX_PORTS = 200
const HTTP_PORTS = new Set([80, 3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888])
const HTTPS_PORTS = new Set([443, 8443])

type RawListeningPort = {
  host: string
  port: number
  pid?: number
  processName?: string
  commandLine?: string
  cwd?: string
}

type ProcessMetadata = {
  processName?: string
  commandLine?: string
  cwd?: string
}

export async function scanWorkspacePorts(
  worktrees: WorkspacePortProbe[]
): Promise<WorkspacePortScanResult> {
  try {
    const rawPorts = await scanPlatformListeningPorts()
    const ports = rawPorts
      .map((port) => enrichPort(port, worktrees))
      .sort(compareWorkspacePorts)
      .slice(0, MAX_PORTS)
    return { platform: process.platform, scannedAt: Date.now(), ports }
  } catch (error) {
    console.warn('[workspace-ports] scan failed', error)
    return {
      platform: process.platform,
      scannedAt: Date.now(),
      ports: [],
      unavailableReason: `Port scanning is unavailable on ${process.platform}.`
    }
  }
}

export function attributePortToWorkspace(
  port: Pick<RawListeningPort, 'cwd' | 'commandLine'>,
  worktrees: WorkspacePortProbe[]
): WorkspacePortOwner | undefined {
  const cwd = port.cwd ? normalizeComparablePath(port.cwd) : null
  const commandLine = port.commandLine ? normalizeComparableText(port.commandLine) : null

  const cwdMatches = cwd
    ? worktrees
        .map((worktree) => ({ worktree, normalizedPath: normalizeComparablePath(worktree.path) }))
        .filter(({ normalizedPath }) => isSameOrDescendant(cwd, normalizedPath))
    : []

  const cwdMatch = pickDeepestMatch(cwdMatches)
  if (cwdMatch) {
    return toOwner(cwdMatch.worktree, 'cwd')
  }

  if (!commandLine) {
    return undefined
  }

  const commandMatches = worktrees
    .map((worktree) => ({ worktree, normalizedPath: normalizeComparablePath(worktree.path) }))
    .filter(({ normalizedPath }) => includesPathBoundary(commandLine, normalizedPath))
  const commandMatch = pickDeepestMatch(commandMatches)
  return commandMatch ? toOwner(commandMatch.worktree, 'command') : undefined
}

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
    const trimmed = line.trim()
    if (!trimmed.toUpperCase().startsWith('TCP')) {
      continue
    }
    const fields = trimmed.split(/\s+/)
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
    const fields = lines[i].trim().split(/\s+/)
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

async function scanPlatformListeningPorts(): Promise<RawListeningPort[]> {
  if (process.platform === 'linux') {
    return scanLinuxProcPorts()
  }
  if (process.platform === 'darwin') {
    return scanDarwinLsofPorts()
  }
  if (process.platform === 'win32') {
    return scanWindowsNetstatPorts()
  }
  throw new Error(`Port scanning is not supported on ${process.platform}`)
}

async function scanDarwinLsofPorts(): Promise<RawListeningPort[]> {
  const { stdout } = await runCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])
  const ports = parseLsofListeningOutput(stdout)
  const metadata = await loadDarwinProcessMetadata(
    new Set(ports.flatMap((p) => (p.pid ? [p.pid] : [])))
  )
  return ports.map((port) => ({ ...metadata.get(port.pid ?? -1), ...port }))
}

async function scanWindowsNetstatPorts(): Promise<RawListeningPort[]> {
  const { stdout } = await runCommand('netstat', ['-ano', '-p', 'tcp'])
  const ports = parseNetstatListeningOutput(stdout)
  const metadata = await loadWindowsProcessMetadata(
    new Set(ports.flatMap((p) => (p.pid ? [p.pid] : [])))
  )
  return ports.map((port) => ({ ...metadata.get(port.pid ?? -1), ...port }))
}

async function scanLinuxProcPorts(): Promise<RawListeningPort[]> {
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

  return dedupeRawPorts(rawPorts)
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

  const [cwdOutput, commandOutput] = await Promise.all([
    runCommand('lsof', ['-a', '-p', pidList, '-d', 'cwd', '-Fn']).catch(() => null),
    runCommand('ps', ['-p', pidList, '-o', 'pid=', '-o', 'command=']).catch(() => null)
  ])

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
    const pidFilter = Array.from(pids)
      .filter(Number.isFinite)
      .map((pid) => `ProcessId=${pid}`)
      .join(' OR ')
    const { stdout } = await runCommand('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "${pidFilter}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
    ])
    const parsed = JSON.parse(stdout) as
      | { ProcessId: number; Name?: string; CommandLine?: string }
      | { ProcessId: number; Name?: string; CommandLine?: string }[]
    for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
      if (pids.has(row.ProcessId)) {
        result.set(row.ProcessId, {
          processName: row.Name,
          commandLine: row.CommandLine
        })
      }
    }
  } catch {
    // Process metadata is optional; port rows still render without attribution.
  }
  return result
}

async function runCommand(command: string, args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  })
  return { stdout: String(stdout) }
}

async function readTextIfAvailable(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return undefined
  }
}

function enrichPort(port: RawListeningPort, worktrees: WorkspacePortProbe[]): WorkspacePort {
  const owner = attributePortToWorkspace(port, worktrees)
  const base = {
    id: `${port.host}:${port.port}:${port.pid ?? 'unknown'}`,
    bindHost: port.host,
    connectHost: connectHostForBindHost(port.host),
    port: port.port,
    pid: port.pid,
    processName: port.processName,
    protocol: inferProtocol(port.port)
  }

  if (owner) {
    return { ...base, kind: 'workspace', owner }
  }
  if (isContainerProcess(port)) {
    return { ...base, kind: 'container' }
  }
  return { ...base, kind: 'external' }
}

function compareWorkspacePorts(a: WorkspacePort, b: WorkspacePort): number {
  const aRank = a.kind === 'workspace' ? 0 : a.kind === 'container' ? 1 : 2
  const bRank = b.kind === 'workspace' ? 0 : b.kind === 'container' ? 1 : 2
  return aRank - bRank || a.port - b.port || a.connectHost.localeCompare(b.connectHost)
}

function inferProtocol(port: number): 'http' | 'https' | 'unknown' {
  if (HTTPS_PORTS.has(port)) {
    return 'https'
  }
  if (HTTP_PORTS.has(port)) {
    return 'http'
  }
  return 'unknown'
}

export function isContainerProcess(
  port: Pick<RawListeningPort, 'processName' | 'commandLine'>
): boolean {
  const haystack = `${port.processName ?? ''} ${port.commandLine ?? ''}`.toLowerCase()
  return /\b(com\.[\w.-]+\.backend|com\.container\w*|container\w*)\b/.test(haystack)
}

function toOwner(
  worktree: WorkspacePortProbe,
  confidence: WorkspacePortOwner['confidence']
): WorkspacePortOwner {
  return {
    worktreeId: worktree.id,
    repoId: worktree.repoId,
    displayName: worktree.displayName,
    path: worktree.path,
    confidence
  }
}

function pickDeepestMatch<T extends { normalizedPath: string }>(matches: T[]): T | undefined {
  return matches.sort((a, b) => b.normalizedPath.length - a.normalizedPath.length)[0]
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

function includesPathBoundary(commandLine: string, normalizedPath: string): boolean {
  let index = commandLine.indexOf(normalizedPath)
  while (index !== -1) {
    const before = index === 0 ? '' : commandLine[index - 1]
    const after = commandLine[index + normalizedPath.length] ?? ''
    const startsOnBoundary = before === '' || /\s|["'=]/.test(before)
    const endsOnBoundary = after === '' || /[\s"'/:]/.test(after)
    if (startsOnBoundary && endsOnBoundary) {
      return true
    }
    index = commandLine.indexOf(normalizedPath, index + normalizedPath.length)
  }
  return false
}

function normalizeComparablePath(input: string): string {
  return normalizeComparableText(path.resolve(input))
}

function normalizeComparableText(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/\/+/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function connectHostForBindHost(host: string): string {
  if (host === '*' || host === '0.0.0.0' || host === '::') {
    return 'localhost'
  }
  return host
}

function dedupeRawPorts(ports: RawListeningPort[]): RawListeningPort[] {
  const seen = new Set<string>()
  const result: RawListeningPort[] = []
  for (const port of ports) {
    const key = `${connectHostForBindHost(port.host)}:${port.port}:${port.pid ?? 'unknown'}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(port)
  }
  return result
}

function parseAddressWithPort(value: string): { host: string; port: number } | null {
  const trimmed = value.trim().replace(/\s+\(LISTEN\)$/i, '')
  const bracketed = trimmed.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketed) {
    return { host: bracketed[1], port: Number.parseInt(bracketed[2], 10) }
  }
  const match = trimmed.match(/^(.+):(\d+)$/)
  if (!match) {
    return null
  }
  const port = Number.parseInt(match[2], 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return null
  }
  return { host: match[1], port }
}

function parseProcAddress(hexAddress: string): { host: string; port: number } | null {
  const [addrHex, portHex] = hexAddress.split(':')
  const port = Number.parseInt(portHex, 16)
  if (!Number.isFinite(port) || port === 0) {
    return null
  }
  if (addrHex.length === 8) {
    const bytes = [6, 4, 2, 0].map((index) => Number.parseInt(addrHex.slice(index, index + 2), 16))
    return { host: bytes.join('.'), port }
  }
  if (addrHex.length === 32) {
    if (addrHex === '00000000000000000000000000000000') {
      return { host: '::', port }
    }
    if (addrHex === '00000000000000000000000001000000') {
      return { host: '::1', port }
    }
    return { host: formatIPv6Address(addrHex), port }
  }
  return null
}

function formatIPv6Address(hex: string): string {
  const groups: string[] = []
  for (let i = 0; i < 32; i += 8) {
    const chunk = hex.slice(i, i + 8)
    const reversed = chunk.slice(6, 8) + chunk.slice(4, 6) + chunk.slice(2, 4) + chunk.slice(0, 2)
    groups.push(reversed.slice(0, 4), reversed.slice(4, 8))
  }
  return groups.map((group) => group.replace(/^0+/, '') || '0').join(':')
}
