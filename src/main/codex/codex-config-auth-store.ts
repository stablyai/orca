import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

// Why: managed Codex homes keep account credentials in auth.json; keyring/auto
// would store them outside the selected home and break deterministic switching.
const FILE_AUTH_CREDENTIALS_STORE_LINE = 'cli_auth_credentials_store = "file"'
const AUTH_CREDENTIALS_STORE_KEY_RE =
  /^[ \t]*(?:"cli_auth_credentials_store"|'cli_auth_credentials_store'|cli_auth_credentials_store)[ \t]*=/
const FILE_AUTH_CREDENTIALS_STORE_RE =
  /^[ \t]*(?:"cli_auth_credentials_store"|'cli_auth_credentials_store'|cli_auth_credentials_store)[ \t]*=[ \t]*(?:"file"|'file')[ \t\r]*(?:#.*)?$/

export function forceFileAuthCredentialsStore(config: string): string {
  const hasBom = config.charCodeAt(0) === 0xfeff
  const content = hasBom ? config.slice(1) : config
  const restoreBom = (value: string): string => (hasBom ? `\uFEFF${value}` : value)
  const lines = content.split('\n')
  let scanState = createTomlLineScanState()

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (isTomlStructuralLine(scanState)) {
      if (getTomlTableHeader(line)) {
        break
      }
      if (AUTH_CREDENTIALS_STORE_KEY_RE.test(line)) {
        if (FILE_AUTH_CREDENTIALS_STORE_RE.test(line)) {
          return config
        }
        const indent = /^[ \t]*/.exec(line)?.[0] ?? ''
        const lineEnding = line.endsWith('\r') ? '\r' : ''
        lines[index] = `${indent}${FILE_AUTH_CREDENTIALS_STORE_LINE}${lineEnding}`
        return restoreBom(lines.join('\n'))
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
  }

  return restoreBom(
    content.length === 0
      ? `${FILE_AUTH_CREDENTIALS_STORE_LINE}\n`
      : `${FILE_AUTH_CREDENTIALS_STORE_LINE}\n${content}`
  )
}
