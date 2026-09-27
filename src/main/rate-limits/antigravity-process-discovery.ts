import { runProcess } from '../../shared/child-process/run-process'

const COMMAND_TIMEOUT_MS = 4_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export type AntigravityProcessInfo = {
  pid: number
  csrfToken: string
  ports: number[]
}

// Why: the local runtime's binary name has changed across Antigravity releases
// (language_server_windows_x64.exe -> language_server.exe); matching a prefix
// instead of an exact name keeps discovery working across both.
function isAntigravityCommandLine(commandLine: string): boolean {
  return (
    /--app_data_dir[=\s]+antigravity\b/i.test(commandLine) ||
    /[\\/]antigravity[\\/]/i.test(commandLine)
  )
}

function extractCsrfToken(commandLine: string): string | null {
  return commandLine.match(/--csrf_token[=\s]+([a-zA-Z0-9-]+)/)?.[1] ?? null
}

function isSafePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
}

async function runShellCommand(script: string): Promise<string | null> {
  // Why: run-process.ts (not a direct child_process import) is Orca's single
  // spawn chokepoint — it resolves the correct Windows binary and always sets
  // windowsHide (see src/shared/child-process/process-spec.ts).
  const result = await runProcess({
    program: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES
  }).catch(() => null)
  if (!result || result.timedOut || result.code !== 0) {
    return null
  }
  return result.stdout
}

async function runPosixCommand(program: string, args: string[]): Promise<string | null> {
  const result = await runProcess({
    program,
    args,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES
  }).catch(() => null)
  if (!result || result.timedOut) {
    return null
  }
  // Why not gate on exit code: pgrep exits 1 for "no match", which is a
  // legitimate "not running" answer here, not a failure to distinguish from one.
  return result.stdout
}

// ─── Windows ────────────────────────────────────────────────────────────────

async function findWindowsProcess(): Promise<{ pid: number; csrfToken: string } | null> {
  // Why: -Filter is a static WQL string with no interpolated data.
  const stdout = await runShellCommand(
    'Get-CimInstance Win32_Process -Filter "Name LIKE \'language_server%\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  )
  if (!stdout) {
    return null
  }
  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const commandLine = (row as { CommandLine?: unknown }).CommandLine
    const pid = (row as { ProcessId?: unknown }).ProcessId
    if (
      typeof commandLine !== 'string' ||
      !isSafePid(pid) ||
      !isAntigravityCommandLine(commandLine)
    ) {
      continue
    }
    const csrfToken = extractCsrfToken(commandLine)
    if (csrfToken) {
      return { pid, csrfToken }
    }
  }
  return null
}

async function findWindowsListeningPorts(pid: number): Promise<number[]> {
  if (!isSafePid(pid)) {
    return []
  }
  const stdout = await runShellCommand(
    `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress`
  )
  if (!stdout) {
    return []
  }
  const trimmed = stdout.trim()
  if (!trimmed) {
    return []
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const values = Array.isArray(parsed) ? parsed : [parsed]
    return values.filter((v): v is number => typeof v === 'number' && Number.isInteger(v))
  } catch {
    return []
  }
}

// ─── macOS / Linux ──────────────────────────────────────────────────────────

function unixProcessPattern(): string {
  return process.platform === 'darwin' ? 'language_server_macos' : 'language_server_linux'
}

async function findUnixProcess(): Promise<{ pid: number; csrfToken: string } | null> {
  const stdout = await runPosixCommand('pgrep', ['-af', unixProcessPattern()])
  if (!stdout) {
    return null
  }
  for (const line of stdout.split('\n')) {
    if (!isAntigravityCommandLine(line)) {
      continue
    }
    const pidMatch = line.trim().match(/^(\d+)\s/)
    const pid = pidMatch ? Number(pidMatch[1]) : Number.NaN
    const csrfToken = extractCsrfToken(line)
    if (isSafePid(pid) && csrfToken) {
      return { pid, csrfToken }
    }
  }
  return null
}

async function findUnixListeningPorts(pid: number): Promise<number[]> {
  if (!isSafePid(pid)) {
    return []
  }
  const stdout = await runPosixCommand('lsof', [
    '-nP',
    '-a',
    '-iTCP',
    '-sTCP:LISTEN',
    '-p',
    String(pid)
  ])
  if (!stdout) {
    return []
  }
  const ports = new Set<number>()
  const portPattern = /(?:127\.0\.0\.1|\*|\[::1?\]):(\d+)\s+\(LISTEN\)/g
  let match: RegExpExecArray | null
  while ((match = portPattern.exec(stdout)) !== null) {
    const port = Number(match[1])
    if (Number.isInteger(port)) {
      ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b)
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Locates the Antigravity IDE's local `language_server` runtime process and
 * the CSRF token + listening ports needed to call its Connect-RPC API.
 * Returns null when Antigravity is not currently running.
 */
export async function discoverAntigravityRuntime(): Promise<AntigravityProcessInfo | null> {
  const found = process.platform === 'win32' ? await findWindowsProcess() : await findUnixProcess()
  if (!found) {
    return null
  }
  const ports =
    process.platform === 'win32'
      ? await findWindowsListeningPorts(found.pid)
      : await findUnixListeningPorts(found.pid)
  if (ports.length === 0) {
    return null
  }
  return { pid: found.pid, csrfToken: found.csrfToken, ports }
}
