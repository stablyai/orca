import { posix, win32 } from 'node:path'

// Frozen pre-runtime-HOME producer: d6e1d842351c4f843d9c4ff2ad750a29c7a211c5.
const DRAINS = [
  'cat >/dev/null 2>&1 || :', // c3a9a5e8a637ac76457dee15a7537b7aa1573741
  '{ command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :' // 17fc40eae66ff35453a7f1197eda1f7740282ad0
]
const SAFE_BASH_PATH = /^[A-Za-z0-9_.:/~-]+$/
const quotePosix = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`

function isReporterPath(path: string, windows: boolean): boolean {
  const api = windows ? win32 : posix
  if (
    !api.isAbsolute(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    return false
  }
  if (windows && !/^[A-Za-z]:[\\/]/.test(path)) {
    return false
  }
  const parent = api.dirname(path)
  return (
    api.basename(path) === `claude-statusline.${windows ? 'cmd' : 'sh'}` &&
    api.basename(parent) === 'agent-hooks' &&
    api.basename(api.dirname(parent)) === '.orca'
  )
}

export function isLegacyStatusLineCommand(command: string): boolean {
  const quoted = command.match(/^if \[ -f ('(?:[^']|'\\'')*') \]/)?.[1]
  if (quoted) {
    const path = quoted.slice(1, -1).replaceAll("'\\''", "'")
    if (quotePosix(path) !== quoted) {
      return false
    }
    if (
      isReporterPath(path, false) &&
      DRAINS.some(
        (drain) =>
          command ===
          `if [ -f ${quoted} ] && [ -r ${quoted} ] && [ -x ${quoted} ]; then /bin/sh ${quoted}; else ${drain}; fi`
      )
    ) {
      return true
    }
    return (
      isReporterPath(path, true) &&
      SAFE_BASH_PATH.test(path) &&
      DRAINS.some((drain) => command === `if [ -f ${quoted} ]; then ${quoted}; else ${drain}; fi`)
    )
  }
  const encoded = command.match(
    /^([A-Za-z]:\/[A-Za-z0-9_./~-]+\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe) -NoProfile -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/]+={0,2})$/
  )
  if (!encoded) {
    return false
  }
  const bytes = Buffer.from(encoded[2], 'base64')
  if (bytes.length % 2 !== 0 || bytes.toString('base64') !== encoded[2]) {
    return false
  }
  const payload = bytes.toString('utf16le')
  const token = payload.match(/^if \(Test-Path -LiteralPath ('(?:[^']|'')*') -PathType Leaf\)/)?.[1]
  if (!token) {
    return false
  }
  const path = token.slice(1, -1).replaceAll("''", "'")
  if (!isReporterPath(path, true) || SAFE_BASH_PATH.test(path.replaceAll('\\', '/'))) {
    return false
  }
  const quotedPath = quotePowerShell(path)
  const expected = `if (Test-Path -LiteralPath ${quotedPath} -PathType Leaf) { & ${quotedPath}; exit $LASTEXITCODE }; [Console]::In.ReadToEnd() | Out-Null; exit 0`
  return (
    command ===
    `${encoded[1]} -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(expected, 'utf16le').toString('base64')}`
  )
}
