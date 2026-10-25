import { posix, win32 } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { getManagedScriptPath } from './codex-hook-definition'

// Enumerate retired forms to avoid deleting live hooks shared with other builds.
// #1019: `/bin/sh "<userData>/agent-hooks/codex-hook.sh"`.
const DOUBLE_QUOTED_SH = /^\/bin\/sh "([^"]+)"$/
// #1536 until hooks left ~/.codex (#2350): `if [ -x '<p>' ]; then /bin/sh '<p>'; fi`.
const EXEC_GUARDED_SH = /^if \[ -x ('(?:[^']|'\\'')*') \]; then \/bin\/sh \1; fi$/
// #9501–#10885 used bare cat; older builds still write command -p cat and must remain untouched.
const BARE_CAT_FILE_GUARDED_SH =
  /^if \[ -f ('(?:[^']|'\\'')*') \] && \[ -r \1 \] && \[ -x \1 \]; then \/bin\/sh \1; else cat >\/dev\/null 2>&1 \|\| :; fi$/
// Windows #9501–#10221 encoded spaced paths; #14825 prefixes shared payloads.
// Match the exact retired payload to preserve current encoded launchers.
const ENCODED_POWERSHELL =
  /^\S+\/powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/]+={0,2})$/
const DECODED_LAUNCHER_PATH = /^if \(Test-Path -LiteralPath ('(?:[^']|'')*') -PathType Leaf\) /

function isAgentHooksScript(scriptPath: string, fileName: string): boolean {
  const pathApi = scriptPath.includes('\\') ? win32 : posix
  return (
    pathApi.basename(scriptPath).toLowerCase() === fileName &&
    pathApi.basename(pathApi.dirname(scriptPath)) === 'agent-hooks'
  )
}

function unquotePosix(quoted: string): string {
  return quoted.slice(1, -1).replaceAll("'\\''", "'")
}

export function isRetiredCodexHookCommand(command: string | undefined): boolean {
  if (!command) {
    return false
  }
  const doubleQuoted = DOUBLE_QUOTED_SH.exec(command)
  if (doubleQuoted) {
    return isAgentHooksScript(doubleQuoted[1]!, 'codex-hook.sh')
  }
  const shGuarded = EXEC_GUARDED_SH.exec(command) ?? BARE_CAT_FILE_GUARDED_SH.exec(command)
  if (shGuarded) {
    return isAgentHooksScript(unquotePosix(shGuarded[1]!), 'codex-hook.sh')
  }
  const encoded = ENCODED_POWERSHELL.exec(command)
  if (encoded) {
    const decoded = Buffer.from(encoded[1]!, 'base64').toString('utf16le')
    const decodedLauncher = DECODED_LAUNCHER_PATH.exec(decoded)
    if (!decodedLauncher) {
      return false
    }
    const quoted = decodedLauncher[1]!
    return (
      decoded ===
        `if (Test-Path -LiteralPath ${quoted} -PathType Leaf) { & ${quoted}; exit $LASTEXITCODE }; [Console]::In.ReadToEnd() | Out-Null; exit 0` &&
      isAgentHooksScript(quoted.slice(1, -1).replaceAll("''", "'"), 'codex-hook.cmd')
    )
  }
  // Pre-#1546 paths used userData; preserve the live shared path in either slash direction.
  return (
    win32.isAbsolute(command) &&
    isAgentHooksScript(command, 'codex-hook.cmd') &&
    normalizeRuntimePathForComparison(command) !==
      normalizeRuntimePathForComparison(getManagedScriptPath())
  )
}
