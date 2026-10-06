import { posix, win32 } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { getManagedScriptPath } from './codex-hook-definition'

// Why enumerated: every Orca build and instance writes the same current command,
// so "any Orca-looking entry that is not mine" would strip a newer or older
// build's live entry. Only forms no build writes any more may be swept.
// #1019: `/bin/sh "<userData>/agent-hooks/codex-hook.sh"`.
const DOUBLE_QUOTED_SH = /^\/bin\/sh "([^"]+)"$/
// #1536 until hooks left ~/.codex (#2350): `if [ -x '<p>' ]; then /bin/sh '<p>'; fi`.
const EXEC_GUARDED_SH = /^if \[ -x ('(?:[^']|'\\'')*') \]; then \/bin\/sh \1; fi$/
// Real-home lane (#9501 until #10885): the file-guarded form draining with a
// bare `cat`. Never the `command -p cat` drain, which builds from before the
// frozen command still write and so must never be swept.
const BARE_CAT_FILE_GUARDED_SH =
  /^if \[ -f ('(?:[^']|'\\'')*') \] && \[ -r \1 \] && \[ -x \1 \]; then \/bin\/sh \1; else cat >\/dev\/null 2>&1 \|\| :; fi$/
// Windows' real-home lane (#9501 until #10221 took Windows off it) wrapped the
// launcher in an encoded command for a non-cmd-safe script path. Codex's current
// launcher is unencoded, and the shared encoded launcher since #14825 prefixes
// its payload, so the exact payload check below matches only the retired form.
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

/** True only for a Codex hook command a retired Orca build wrote into ~/.codex. */
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
  // Why: before #1546 Windows wrote a bare per-userData script path; the bare
  // shared path, in either slash direction, is still written, so it never matches.
  return (
    win32.isAbsolute(command) &&
    isAgentHooksScript(command, 'codex-hook.cmd') &&
    normalizeRuntimePathForComparison(command) !==
      normalizeRuntimePathForComparison(getManagedScriptPath())
  )
}
