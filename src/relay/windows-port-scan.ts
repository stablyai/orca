import { readWindowsProcessTable } from '../main/windows/windows-process-table'
import { runProcess } from '../shared/child-process/run-process'
import {
  windowsPowerShellPath,
  windowsSystem32Binary
} from '../shared/child-process/windows-system-binary'
import { getProcessOutputFields } from '../shared/process-output-field-scanner'
import type { DetectedPort } from './port-scan-handler'
import { buildRelayCommandEnv } from './relay-command-env'
import { relayLogLine } from './relay-diagnostic-log'

const SYSTEM_PORTS_TO_EXCLUDE = new Set([22])
const MAX_DETECTED_PORTS = 50
const WINDOWS_PORT_SCAN_TIMEOUT_MS = 5_000
// Wide enough for `netstat -ano` on a busy host: it prints every connection, not
// just the listeners, and a truncated table silently drops the tail.
const WINDOWS_PORT_SCAN_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * Listening TCP ports, attributed to their owning process.
 *
 * `netstat.exe -ano` answers all of it except the process name, which comes
 * from the shared process table -- so this scan starts no PowerShell of its
 * own. One still runs on a released relay: without the optional
 * `windows-process-tree.node` addon (built only by dev-channel-win-build.yml,
 * so no release carries it) that table falls back to a CIM scan that forks one
 * `powershell.exe`. That scan is TTL-shared with pane naming, so a relay with a
 * live pane pays nothing extra for it.
 *
 * The EDR win is therefore the shape, not the absence of PowerShell. The
 * retired payload ran `-ExecutionPolicy Bypass -EncodedCommand <base64>`
 * wrapping `Get-NetTCPConnection` joined to `Get-Process`: base64 beside a
 * policy override is the highest-weighted token pair Defender for Endpoint
 * scores on a PowerShell command line, and listing listeners with their owners
 * reads as network discovery (T1049) on top of it. The shared CIM scan carries
 * neither token. That payload survives only as the last resort below, without
 * the override.
 */
export async function scanWindowsListeningPorts(signal?: AbortSignal): Promise<DetectedPort[]> {
  const netstatPorts = await readWindowsNetstatPorts(signal)
  if (netstatPorts) {
    return normalizeWindowsDetectedPorts(await attachWindowsProcessNames(netstatPorts, signal))
  }
  if (signal?.aborted) {
    return []
  }
  try {
    const json = await runWindowsPortScanPowerShell(signal)
    return normalizeWindowsDetectedPorts(parseWindowsPowerShellPortRows(json))
  } catch {
    return []
  }
}

/** Rows, or null when netstat could not answer and the fallback should run. */
async function readWindowsNetstatPorts(signal?: AbortSignal): Promise<DetectedPort[] | null> {
  let stdout: string
  try {
    const result = await runProcess({
      program: windowsSystem32Binary('netstat.exe'),
      // No `-p tcp`: on Windows that protocol name means TCP over IPv4 only, so
      // it hides every `[::]` listener the retired PowerShell payload reported.
      args: ['-ano'],
      env: buildRelayCommandEnv(),
      timeoutMs: WINDOWS_PORT_SCAN_TIMEOUT_MS,
      maxOutputBytes: WINDOWS_PORT_SCAN_MAX_OUTPUT_BYTES,
      signal
    })
    if (result.timedOut || result.code !== 0) {
      return null
    }
    // A capped read still exits 0 and its head still parses, so nothing
    // downstream can tell a partial table from a whole one. netstat prints IPv4
    // TCP, then IPv6 TCP, then UDP, so the rows lost first are exactly the
    // `[::]` listeners that dropping `-p tcp` above exists to keep. Refuse the
    // whole read rather than publish its head.
    if (Buffer.byteLength(result.stdout) >= WINDOWS_PORT_SCAN_MAX_OUTPUT_BYTES) {
      reportWindowsNetstatUnusable('output hit the capture cap and was truncated')
      return null
    }
    stdout = result.stdout
  } catch {
    return null
  }
  const ports = parseWindowsNetstatOutput(stdout)
  // Windows always has a listener (RPC endpoint mapper, SMB), so an exit-0 scan
  // that parses to nothing is a reader that was blocked, not an idle host.
  if (ports.length === 0) {
    reportWindowsNetstatUnusable('exited 0 but no listening row parsed')
    return null
  }
  return ports
}

/** Reasons already reported. A fixed two-value vocabulary, so it cannot grow. */
const reportedNetstatFailures = new Set<string>()

/**
 * Say once why the scan left the native path.
 *
 * Both fall-throughs are permanent when they are wrong — the host stays on the
 * PowerShell payload, or on nothing, for the life of the relay — and the scan
 * repeats every 12-30s, so this logs one line rather than a stream.
 *
 * Through relayLogLine, not console.warn: this only ever runs in the detached
 * daemon, whose stderr installRelayLogRotation routes into the relay.log that
 * the remote-diagnostics tail reads. An untimestamped line in that file cannot
 * be placed against the reconnect flaps around it (#7773), and "since when" is
 * most of what this line is for.
 */
function reportWindowsNetstatUnusable(reason: string): void {
  // Per reason, not per module: a host that parses nothing today and truncates
  // tomorrow has two different faults, and one flag would hide the second.
  if (reportedNetstatFailures.has(reason)) {
    return
  }
  reportedNetstatFailures.add(reason)
  relayLogLine(`[ports] netstat unusable on this host (${reason}); falling back to PowerShell`)
}

/** Test-only: re-arm the one-shot so each case can observe its own line. */
export function resetWindowsPortScanDiagnosticsForTests(): void {
  reportedNetstatFailures.clear()
}

/**
 * Fill in owning-process names from the shared process-table snapshot.
 *
 * Names are optional data — the panel renders host/port/pid without them — so a
 * host that cannot read the table keeps its rows. This shares whatever scan the
 * table already runs rather than avoiding one, and on a relay that scan is a
 * `powershell.exe` CIM query -- no released relay carries the native addon, so
 * that is the path every SSH host takes, not a fallback.
 * See docs/reference/windows-process-enumeration.md.
 *
 * Only `name` is read here, so this wants `readWindowsProcessIdentityTable`
 * once #17866 lands -- on the detailed reader it would pay per-process handles
 * for a field it discards.
 *
 * Best-effort by design: the snapshot is shared and TTL-cached, so it can
 * predate netstat and hand a recycled PID its previous owner's name. Only
 * labels read this field, and a fresh read would cost every caller a scan.
 */
async function attachWindowsProcessNames(
  ports: DetectedPort[],
  signal?: AbortSignal
): Promise<DetectedPort[]> {
  const pids = new Set(ports.flatMap((port) => (port.pid == null ? [] : [port.pid])))
  // The shared snapshot takes no signal and must not be cancelled on one
  // caller's behalf, so an abandoned scan declines to wait for it instead.
  if (pids.size === 0 || signal?.aborted) {
    return ports
  }
  let names: Map<number, string>
  try {
    const rows = await readWindowsProcessTable()
    names = new Map(
      rows.flatMap((row) =>
        pids.has(row.pid) && row.name ? [[row.pid, stripExecutableSuffix(row.name)] as const] : []
      )
    )
  } catch {
    return ports
  }
  return ports.map((port) => {
    const processName = port.pid == null ? undefined : names.get(port.pid)
    return processName ? { ...port, processName } : port
  })
}

// The process table reports `sshd.exe`; the retired `Get-Process` payload
// reported `sshd`. The sshd filter below and every client that already renders
// these rows read the bare name, so keep publishing that spelling.
function stripExecutableSuffix(name: string): string {
  return name.replace(/\.exe$/i, '')
}

/**
 * Single line so it survives as one argv element regardless of how the
 * shell-less spawn hands it to PowerShell's `-Command` parser. Exported so
 * windows-port-scan.win32.test.ts can run it: a missing `;` between statements
 * is a parse error the mocked tests cannot see.
 */
export const WINDOWS_PORT_SCAN_SCRIPT = [
  "$ErrorActionPreference = 'Stop';",
  'Get-NetTCPConnection -State Listen | ForEach-Object {',
  '$connection = $_; $name = $null;',
  'try { $name = (Get-Process -Id $connection.OwningProcess -ErrorAction Stop).ProcessName } catch { };',
  '[pscustomobject]@{ host = [string]$connection.LocalAddress; port = [int]$connection.LocalPort;',
  'pid = [int]$connection.OwningProcess; processName = $name }',
  '} | ConvertTo-Json -Compress -Depth 3'
].join(' ')

async function runWindowsPortScanPowerShell(signal?: AbortSignal): Promise<string> {
  let lastError: unknown

  for (const program of [windowsPowerShellPath(), 'pwsh.exe']) {
    try {
      const result = await runProcess({
        program,
        // No `-ExecutionPolicy` override: the policy gates script *files*, never
        // `-Command`. Verified on Windows 11 — `-ExecutionPolicy Restricted
        // -Command` still runs, while `-File` against an unsigned .ps1 does not.
        args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PORT_SCAN_SCRIPT],
        env: buildRelayCommandEnv(),
        timeoutMs: WINDOWS_PORT_SCAN_TIMEOUT_MS,
        maxOutputBytes: WINDOWS_PORT_SCAN_MAX_OUTPUT_BYTES,
        signal
      })
      if (signal?.aborted) {
        throw new Error('windows port scan aborted')
      }
      if (result.timedOut || result.code !== 0) {
        lastError ??= new Error(
          `windows port scan PowerShell failed (code=${result.code} timedOut=${result.timedOut})`
        )
        continue
      }
      return result.stdout
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
      lastError ??= error
    }
  }

  throw lastError ?? new Error('PowerShell unavailable')
}

export function parseWindowsPowerShellPortRows(json: string): DetectedPort[] {
  const trimmed = json.trim()
  if (!trimmed) {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((row) => parseWindowsPortRow(row))
}

/**
 * Listening rows, on a host in any UI language.
 *
 * `LISTENING` is not in `netstat.exe` — it lives in
 * `System32\<locale>\netstat.exe.mui` beside `ESTABLISHED` and `Proto`, and MUI
 * selection follows the UI language, so the pinned-locale env in
 * relay-command-env.ts cannot reach it. A German host prints `ABHÖREN` and the
 * word test finds nothing at all.
 *
 * The shape is language-independent: a listening socket has no peer, so its
 * foreign address is `0.0.0.0:0` / `[::]:0`, and on every state Windows prints
 * with a real peer that port is non-zero. Shape stays the fallback because the
 * converse does not hold — `BOUND` and `CLOSED` print a zero peer too, and on a
 * localized host their words are just as unreadable as the listening one.
 */
export function parseWindowsNetstatOutput(output: string): DetectedPort[] {
  const { rows, tcpRows } = scanWindowsNetstatTcpRows(output)
  const byStateWord = rows.filter((row) => row.state === 'LISTENING')
  if (byStateWord.length > 0 || tcpRows === 0) {
    return byStateWord.map((row) => row.port)
  }
  return readDominantZeroPeerState(rows)
}

/**
 * Of the zero-peer states, keep only the one that dominates.
 *
 * Shape alone would publish a phantom listener: one `BOUND` socket among real
 * listeners looks identical to them once the state word is unreadable. But it
 * cannot dominate — listeners outnumber those transients by roughly 50:1 on a
 * real host (51 against 0 here), so the largest zero-peer group is the
 * listening one. An exact tie keeps every tied group rather than guessing,
 * which is no worse than reading shape alone.
 *
 * A majority rule inverts if the majority is wrong: enough transient zero-peer
 * sockets and the phantoms win, publishing those and dropping the real
 * listeners. The hatch is to return [] here and defer to the PowerShell reader,
 * which reads the state word instead of inferring it.
 */
function readDominantZeroPeerState(rows: NetstatTcpRow[]): DetectedPort[] {
  const countByState = new Map<string, number>()
  for (const row of rows) {
    if (row.zeroPeer) {
      countByState.set(row.state, (countByState.get(row.state) ?? 0) + 1)
    }
  }
  const largest = Math.max(0, ...countByState.values())
  const dominant = new Set(
    [...countByState].filter(([, count]) => count === largest).map(([state]) => state)
  )
  return rows.flatMap((row) => (row.zeroPeer && dominant.has(row.state) ? [row.port] : []))
}

type NetstatTcpRow = { state: string; zeroPeer: boolean; port: DetectedPort }

/** `tcpRows` separates a localized host from one with genuinely no TCP output. */
function scanWindowsNetstatTcpRows(output: string): { rows: NetstatTcpRow[]; tcpRows: number } {
  const rows: NetstatTcpRow[] = []
  let tcpRows = 0

  for (const line of output.split(/\r?\n/)) {
    const fields = getProcessOutputFields(line, 5)
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') {
      continue
    }
    tcpRows += 1
    const hostPort = parseWindowsNetstatAddress(fields[1])
    const pid = Number.parseInt(fields[4], 10)
    if (!hostPort || !Number.isSafeInteger(pid) || pid <= 0) {
      continue
    }
    rows.push({
      state: fields[3].toUpperCase(),
      zeroPeer: readWindowsNetstatPort(fields[2]) === 0,
      port: { ...hostPort, pid }
    })
  }

  return { rows, tcpRows }
}

function parseWindowsPortRow(row: unknown): DetectedPort[] {
  if (!row || typeof row !== 'object') {
    return []
  }
  const value = row as {
    host?: unknown
    LocalAddress?: unknown
    port?: unknown
    LocalPort?: unknown
    pid?: unknown
    OwningProcess?: unknown
    processName?: unknown
    ProcessName?: unknown
  }
  const host = readString(value.host ?? value.LocalAddress)
  const port = readInteger(value.port ?? value.LocalPort)
  const pid = readInteger(value.pid ?? value.OwningProcess)
  const processName = readString(value.processName ?? value.ProcessName)
  if (!host || port == null || pid == null) {
    return []
  }
  return [
    {
      host,
      port,
      pid,
      ...(processName ? { processName } : {})
    }
  ]
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** Port alone, keeping 0 — the foreign-address test above turns on that value. */
function readWindowsNetstatPort(value: string): number | null {
  const ipv6Match = /^\[.*\]:(\d+)$/.exec(value)
  const portText = ipv6Match?.[1] ?? value.slice(value.lastIndexOf(':') + 1)
  const port = Number.parseInt(portText, 10)
  return Number.isSafeInteger(port) ? port : null
}

function parseWindowsNetstatAddress(value: string): { host: string; port: number } | null {
  const port = readWindowsNetstatPort(value)
  if (port == null || port <= 0) {
    return null
  }
  const ipv6Match = /^\[(.*)\]:\d+$/.exec(value)
  if (ipv6Match) {
    return { host: ipv6Match[1], port }
  }
  const idx = value.lastIndexOf(':')
  if (idx <= 0) {
    return null
  }
  return { host: value.slice(0, idx), port }
}

function normalizeWindowsDetectedPorts(ports: DetectedPort[]): DetectedPort[] {
  const seen = new Set<string>()
  const relayPid = process.pid
  const relayParentPid = process.ppid
  const normalized: DetectedPort[] = []

  for (const port of ports) {
    const processName = port.processName?.toLowerCase()
    const key = `${port.host}:${port.port}:${port.pid ?? ''}`
    if (
      seen.has(key) ||
      SYSTEM_PORTS_TO_EXCLUDE.has(port.port) ||
      port.pid === relayPid ||
      port.pid === relayParentPid ||
      processName === 'sshd'
    ) {
      continue
    }
    seen.add(key)
    normalized.push(port)
  }

  normalized.sort((a, b) => a.port - b.port || a.host.localeCompare(b.host))
  return normalized.slice(0, MAX_DETECTED_PORTS)
}
