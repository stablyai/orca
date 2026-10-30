import { PROXY_ENVIRONMENT_KEYS } from '../../shared/network-proxy'
import {
  execCommand,
  isSshCommandExitError,
  isSshExecTimeout,
  isUnconfirmedSshCommandTermination
} from './remote-exec/remote-exec-command'
import { powerShellCommand } from './ssh-remote-powershell'
import { isSshSessionLimitError } from './ssh-session-limit-error'

type ProxyEnvironmentTransport = Parameters<typeof execCommand>[0]

const PROBE_TIMEOUT_MS = 8_000
const MARKER = '__ORCA_HOST_PROXY_ENV__'

// Values travel as hex of their UTF-8 bytes, so newlines and console code pages cannot alter them.
const POSIX_PROBE = PROXY_ENVIRONMENT_KEYS.map(
  (key) =>
    `[ -z "\${${key}-}" ] || printf '%s %s=%s\\n' ${MARKER} ${key} "$(printf %s "$${key}" | od -An -v -tx1 | tr -d ' \\n')"`
).join('; ')

const POWERSHELL_PROBE = [
  `foreach ($k in @(${PROXY_ENVIRONMENT_KEYS.map((key) => `'${key}'`).join(', ')})) {`,
  '$v = [Environment]::GetEnvironmentVariable($k);',
  "if ($v) { $h = ([Text.Encoding]::UTF8.GetBytes($v) | ForEach-Object { $_.ToString('x2') }) -join '';",
  `Write-Output ('${MARKER} ' + $k + '=' + $h) } }`
].join(' ')

/** Reads the proxy variables an SSH exec session gets, the environment processes launched over SSH (such as orcad) run with. */
export async function readSshHostProxyEnvironment(
  conn: ProxyEnvironmentTransport,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const options = { timeoutMs: PROBE_TIMEOUT_MS, ...(signal ? { signal } : {}) }
  try {
    return parseProxyEnvironment(await execCommand(conn, POSIX_PROBE, options))
  } catch (posixError) {
    signal?.throwIfAborted()
    // Only a host that answered can be a Windows host; a lost or saturated session would fail again.
    if (
      isSshExecTimeout(posixError) ||
      isUnconfirmedSshCommandTermination(posixError) ||
      isSshSessionLimitError(posixError)
    ) {
      throw posixError
    }
    try {
      const output = await execCommand(conn, powerShellCommand(POWERSHELL_PROBE), {
        ...options,
        wrapCommand: false
      })
      return parseProxyEnvironment(output)
    } catch {
      signal?.throwIfAborted()
      throw posixError
    }
  }
}

const HOST_PROXY_ENVIRONMENT_RETRY_MS = 15_000

/** Until a read succeeds, dials go direct as they did before this route read the host's proxy, and later dials retry the read. */
export async function loadHostProxyEnvironment(
  read: (signal: AbortSignal) => Promise<Record<string, string>>,
  signal: AbortSignal
): Promise<() => Record<string, string>> {
  let known: Record<string, string> | null = null
  let pending: Promise<void> | null = null
  let lastAttemptAt = 0
  const attempt = (): Promise<void> => {
    lastAttemptAt = Date.now()
    pending = read(signal)
      .then(
        (env) => {
          known = env
        },
        (error: unknown) => {
          if (!signal.aborted) {
            console.warn(
              `[browser] could not read the SSH host proxy environment; dialing directly: ${describeProbeError(error)}`
            )
          }
        }
      )
      .finally(() => {
        pending = null
      })
    return pending
  }
  await attempt()
  return () => {
    if (
      !known &&
      !pending &&
      !signal.aborted &&
      Date.now() - lastAttemptAt >= HOST_PROXY_ENVIRONMENT_RETRY_MS
    ) {
      void attempt()
    }
    return known ?? {}
  }
}

// An exit error's message carries the probe's stdout, which may hold proxy credentials.
function describeProbeError(error: unknown): string {
  if (isSshCommandExitError(error)) {
    return `exit ${error.exitCode}`
  }
  return error instanceof Error ? error.message : String(error)
}

function parseProxyEnvironment(output: string): Record<string, string> {
  const env: Record<string, string> = {}
  // Require the marker; Windows output is unfenced and may carry startup noise.
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(`${MARKER} `)) {
      continue
    }
    const entry = line.slice(MARKER.length + 1)
    const separator = entry.indexOf('=')
    const key = entry.slice(0, separator)
    const hex = entry.slice(separator + 1).trim()
    if (
      separator > 0 &&
      hex &&
      /^(?:[0-9a-f]{2})+$/i.test(hex) &&
      PROXY_ENVIRONMENT_KEYS.includes(key)
    ) {
      env[key] = Buffer.from(hex, 'hex').toString('utf8')
    }
  }
  return env
}
