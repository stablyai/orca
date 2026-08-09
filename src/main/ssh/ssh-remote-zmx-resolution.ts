import type { SshConnection } from './ssh-connection'
import { buildSshLoginShellCommand } from './ssh-login-shell-command'
import { execCommand } from './ssh-relay-deploy-helpers'
import { parseRemoteZmxPath } from './ssh-relay-pty-backend'

const ZMX_PROBE_TIMEOUT_MS = 8_000

export async function resolveRemoteZmxPath(
  conn: SshConnection,
  signal?: AbortSignal
): Promise<string> {
  const options = signal
    ? { signal, timeoutMs: ZMX_PROBE_TIMEOUT_MS }
    : { timeoutMs: ZMX_PROBE_TIMEOUT_MS }
  const knownPathProbe = [
    'command -v zmx 2>/dev/null',
    'for candidate in /opt/homebrew/bin/zmx /usr/local/bin/zmx "$HOME/.local/bin/zmx" "$HOME/bin/zmx"; do',
    '  [ -x "$candidate" ] && printf \'%s\\n\' "$candidate"',
    'done',
    'true'
  ].join('\n')
  const probed = await execCommand(conn, knownPathProbe, options).catch(() => '')
  signal?.throwIfAborted()
  for (const line of probed.split(/\r?\n/)) {
    try {
      return parseRemoteZmxPath(line)
    } catch {
      // Probe output may include shell startup noise.
    }
  }

  const shell = (
    await execCommand(conn, 'echo "${SHELL:-/bin/sh}"', options).catch(() => '')
  ).trim()
  signal?.throwIfAborted()
  if (shell) {
    const loginOptions = signal
      ? { signal, timeoutMs: ZMX_PROBE_TIMEOUT_MS, wrapCommand: false }
      : { timeoutMs: ZMX_PROBE_TIMEOUT_MS, wrapCommand: false }
    const loginResult = await execCommand(
      conn,
      buildSshLoginShellCommand(
        shell.split(/\r?\n/, 1)[0],
        // Why: rc noise can emit absolute-path-looking lines before command -v
        // prints; a sentinel plus an executability check isolates the result.
        'p=$(command -v zmx 2>/dev/null); [ -n "$p" ] && [ -x "$p" ] && printf \'ORCA_ZMX_PATH:%s\\n\' "$p"'
      ),
      loginOptions
    ).catch(() => '')
    signal?.throwIfAborted()
    const sentinelLines = loginResult
      .split(/\r?\n/)
      .filter((line) => line.startsWith('ORCA_ZMX_PATH:'))
    // Why: prefer the last sentinel — anything earlier is rc-file noise.
    for (const line of sentinelLines.toReversed()) {
      try {
        return parseRemoteZmxPath(line.slice('ORCA_ZMX_PATH:'.length))
      } catch {
        // A noisy line may still fake the sentinel; keep scanning.
      }
    }
  }

  signal?.throwIfAborted()
  return parseRemoteZmxPath('')
}
