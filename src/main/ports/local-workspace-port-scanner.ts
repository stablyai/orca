/* eslint-disable max-lines -- Why: the platform-specific scan paths share parsing,
attribution, and normalization rules that must stay in lockstep. */
import { readFile, readdir, readlink } from 'node:fs/promises'
import path from 'node:path'
import type {
  WorkspacePort,
  WorkspacePortOwner,
  WorkspacePortProbe,
  WorkspacePortScanResult
} from '../../shared/workspace-ports'
import { getProcessOutputFields } from '../../shared/process-output-field-scanner'
import { readWindowsProcessTable } from '../windows/windows-process-table'
import { advertisedUrlWatcher, type AdvertisedUrlWatcher } from './advertised-url-watcher'
import { isPortScanWorkerUnavailableError, runPortScanCommand } from './port-scan-command-client'
import { PortScanCommandTimeoutError } from './port-scan-command-protocol'
import { WorkspacePortScanTimeoutBackoff } from './workspace-port-scan-timeout-backoff'

// Why (#11161): on an EDR-hooked host process creation alone can take seconds.
// Past this, skip the scan's optional metadata commands for one cycle so a scan
// costs roughly one stall instead of three.
const SLOW_SPAWN_SKIP_METADATA_MS = 2_000
const MAX_PORTS = 200
const HTTP_PORTS = new Set([80, 3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888])
const HTTPS_PORTS = new Set([443, 8443])

const commandTimeoutBackoff = new WorkspacePortScanTimeoutBackoff()
let loggedWorkerUnavailable = false
// Why (#11161): a hooked host stalls every spawn, so gating only on the current
// scan would drop metadata forever. Never skip twice running, so attribution —
// and the Stop action and advertised-URL matching that ride on it — recovers on
// the next tick.
let skippedMetadataOnLastScan = false
// Why (#11161): a skipped cycle would otherwise report every listener as
// external, so the panel flip-flops and the Stop action loses its owner. Carry
// the previous cycle's metadata forward, keyed tightly enough that a recycled
// pid cannot inherit it.
let lastListenerMetadata = new Map<string, ProcessMetadata>()

export type WorkspacePortScanOptions = {
  /** Set by attribution-dependent callers (Stop, the localhost-label allowlist)
   *  that must never trade owner metadata for scan latency. */
  requireMetadata?: boolean
}

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

type NormalizedWorkspacePortProbe = {
  worktree: WorkspacePortProbe
  normalizedPath: string
}

type PlatformListeningPortScan = {
  ports: RawListeningPort[]
  /** False when a stalled spawn made the scan skip its cwd/command-line probes. */
  metadataAvailable: boolean
}

export async function scanWorkspacePorts(
  worktrees: WorkspacePortProbe[],
  urlWatcher: Pick<AdvertisedUrlWatcher, 'lookup' | 'reconcileScan'> = advertisedUrlWatcher,
  options: WorkspacePortScanOptions = {}
): Promise<WorkspacePortScanResult> {
  const cooldown = commandTimeoutBackoff.snapshot()
  if (cooldown.isCoolingDown) {
    return makeUnavailableScan(
      `Port scanning is temporarily paused after a command timeout. Retrying in ${Math.ceil(
        cooldown.remainingMs / 1000
      )}s.`
    )
  }

  try {
    const { ports: rawPorts, metadataAvailable } = await scanPlatformListeningPorts(options)
    commandTimeoutBackoff.recordSuccess()
    const normalizedWorktrees = normalizeWorkspacePortProbes(worktrees)
    // Why (#11161): without cwd/command-line every port looks unattributed, and
    // reconciling that would read as "the listener vanished" and evict cached
    // advertised URLs that only live PTY output can ever restore.
    if (metadataAvailable) {
      reconcileAdvertisedUrls(rawPorts, normalizedWorktrees, urlWatcher)
    }
    const ports = rawPorts
      .map((port) => enrichPort(port, normalizedWorktrees, urlWatcher))
      .sort(compareWorkspacePorts)
      .slice(0, MAX_PORTS)
    return { platform: process.platform, scannedAt: Date.now(), ports }
  } catch (error) {
    if (isCommandTimeoutError(error)) {
      commandTimeoutBackoff.recordTimeout()
    }
    warnScanFailure(error)
    return makeUnavailableScan(`Port scanning is unavailable on ${process.platform}.`)
  }
}

export function resetWorkspacePortScanTimeoutBackoffForTests(): void {
  commandTimeoutBackoff.reset()
  loggedWorkerUnavailable = false
  skippedMetadataOnLastScan = false
  lastListenerMetadata = new Map()
}

function shouldSkipMetadataCommands(spawnMs: number, opts: WorkspacePortScanOptions): boolean {
  if (opts.requireMetadata) {
    // Leave the skip parity alone: it belongs to the background scan cadence,
    // and a one-shot user action must not shift which tick degrades.
    return false
  }
  const skip = spawnMs > SLOW_SPAWN_SKIP_METADATA_MS && !skippedMetadataOnLastScan
  skippedMetadataOnLastScan = skip
  return skip
}

/** Identity tight enough that a recycled pid cannot inherit stale metadata. */
function listenerMetadataKey(port: RawListeningPort): string {
  return `${port.pid ?? 'unknown'}:${port.host}:${port.port}`
}

function rememberListenerMetadata(ports: readonly RawListeningPort[]): void {
  lastListenerMetadata = new Map(
    ports.map((port) => [
      listenerMetadataKey(port),
      { processName: port.processName, commandLine: port.commandLine, cwd: port.cwd }
    ])
  )
}

function recallListenerMetadata(port: RawListeningPort): RawListeningPort {
  const remembered = lastListenerMetadata.get(listenerMetadataKey(port))
  if (!remembered) {
    return port
  }
  return {
    ...port,
    processName: port.processName ?? remembered.processName,
    commandLine: port.commandLine ?? remembered.commandLine,
    cwd: port.cwd ?? remembered.cwd
  }
}

// Why: a mispackaged probe worker fails identically forever, so logging it on
// every 30s scan tick is pure noise.
function warnScanFailure(error: unknown): void {
  if (isPortScanWorkerUnavailableError(error)) {
    if (loggedWorkerUnavailable) {
      return
    }
    loggedWorkerUnavailable = true
  }
  console.warn('[workspace-ports] scan failed', error)
}

function makeUnavailableScan(reason: string): WorkspacePortScanResult {
  return {
    platform: process.platform,
    scannedAt: Date.now(),
    ports: [],
    unavailableReason: reason
  }
}

export function attributePortToWorkspace(
  port: Pick<RawListeningPort, 'cwd' | 'commandLine'>,
  worktrees: WorkspacePortProbe[]
): WorkspacePortOwner | undefined {
  return attributePortToNormalizedWorkspaces(port, normalizeWorkspacePortProbes(worktrees))
}

function normalizeWorkspacePortProbes(
  worktrees: readonly WorkspacePortProbe[]
): NormalizedWorkspacePortProbe[] {
  return worktrees.map((worktree) => ({
    worktree,
    normalizedPath: normalizeComparablePath(worktree.path)
  }))
}

function attributePortToNormalizedWorkspaces(
  port: Pick<RawListeningPort, 'cwd' | 'commandLine'>,
  worktrees: readonly NormalizedWorkspacePortProbe[]
): WorkspacePortOwner | undefined {
  const cwd = port.cwd ? normalizeComparablePath(port.cwd) : null
  const commandLine = port.commandLine ? normalizeComparableText(port.commandLine) : null

  const cwdMatch = cwd
    ? pickDeepestMatching(worktrees, ({ normalizedPath }) =>
        isSameOrDescendant(cwd, normalizedPath)
      )
    : undefined
  if (cwdMatch) {
    return toOwner(cwdMatch.worktree, 'cwd')
  }

  if (!commandLine) {
    return undefined
  }

  const commandMatch = pickDeepestMatching(worktrees, ({ normalizedPath }) =>
    includesPathBoundary(commandLine, normalizedPath)
  )
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

async function scanPlatformListeningPorts(
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

function isCommandTimeoutError(error: unknown): boolean {
  return error instanceof PortScanCommandTimeoutError
}

async function readTextIfAvailable(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return undefined
  }
}

function enrichPort(
  port: RawListeningPort,
  worktrees: readonly NormalizedWorkspacePortProbe[],
  urlWatcher: Pick<AdvertisedUrlWatcher, 'lookup'>
): WorkspacePort {
  const owner = attributePortToNormalizedWorkspaces(port, worktrees)
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
    // Why: only enrich workspace-attributed ports. Container and external
    // ports may have URLs printed in unrelated terminals — the worktree
    // scoping is the primary false-positive filter.
    const advertised = urlWatcher.lookup(owner.worktreeId, port.port, port.pid)
    return {
      ...base,
      protocol: advertised?.protocol ?? base.protocol,
      kind: 'workspace',
      owner,
      ...(advertised ? { advertisedUrl: advertised.origin } : {})
    }
  }
  if (isContainerProcess(port)) {
    return { ...base, kind: 'container' }
  }
  return { ...base, kind: 'external' }
}

function reconcileAdvertisedUrls(
  ports: RawListeningPort[],
  worktrees: readonly NormalizedWorkspacePortProbe[],
  urlWatcher: Pick<AdvertisedUrlWatcher, 'reconcileScan'>
): void {
  const observationsByWorktree = new Map<string, { port: number; pid?: number }[]>()
  for (const worktree of worktrees) {
    observationsByWorktree.set(worktree.worktree.id, [])
  }
  for (const port of ports) {
    const owner = attributePortToNormalizedWorkspaces(port, worktrees)
    if (!owner) {
      continue
    }
    observationsByWorktree.get(owner.worktreeId)?.push({ port: port.port, pid: port.pid })
  }
  for (const [worktreeId, observations] of observationsByWorktree) {
    // Why: the scanner sees port disappearance and PID changes before a lazy
    // lookup would otherwise pin a stale banner to a new listener.
    urlWatcher.reconcileScan([worktreeId], observations)
  }
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

function pickDeepestMatching<T extends { normalizedPath: string }>(
  candidates: readonly T[],
  predicate: (candidate: T) => boolean
): T | undefined {
  let best: T | undefined
  for (const candidate of candidates) {
    if (!predicate(candidate)) {
      continue
    }
    if (!best || candidate.normalizedPath.length > best.normalizedPath.length) {
      best = candidate
    }
  }
  return best
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
  if (input.startsWith('/')) {
    // Why: command-line evidence for SSH/WSL/POSIX workspaces can be evaluated
    // on a Windows host; path.resolve would reinterpret "/repo" as "G:/repo".
    return normalizeComparableText(path.posix.resolve(input))
  }
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
