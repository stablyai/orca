import {
  createTomlLineScanState,
  isTomlStructuralLine,
  joinPreservingTrailingNewline,
  updateTomlLineScanState
} from '../toml/config-toml-line-scan'
import { upsertTopLevelSettingsInContent } from './codex-config-settings-upsert'

// Orca managed accounts manage credentials through the managed home's auth.json; keyring-backed
// logins are invisible to every auth.json reader (identity capture, readiness, mirrors).
export const CODEX_CREDENTIAL_STORE_PIN_MARKER =
  '# orca: managed accounts keep credentials in auth.json'

const PINNED_RAW = `"file" ${CODEX_CREDENTIAL_STORE_PIN_MARKER}`

/** The full pinned line as it appears in a managed home's config.toml. */
export const CODEX_CREDENTIAL_STORE_PIN_LINE = `cli_auth_credentials_store = ${PINNED_RAW}\n`

/** Pins the credential store to `file` in an Orca-managed Codex home's config. */
export function applyManagedHomeCredentialStorePin(config: string): string {
  return upsertTopLevelSettingsInContent(
    config,
    new Map([['cli_auth_credentials_store', PINNED_RAW]])
  )
}

/** Remove marked lines so the pin never reaches the real ~/.codex config. */
export function stripManagedHomeCredentialStorePin(config: string): string {
  if (!config.includes(CODEX_CREDENTIAL_STORE_PIN_MARKER)) {
    return config
  }
  const usesCrlf = config.includes('\r\n')
  const kept: string[] = []
  let state = createTomlLineScanState()
  for (const line of config.split('\n')) {
    const structural = isTomlStructuralLine(state)
    state = updateTomlLineScanState(state, line)
    if (structural && line.trimEnd().endsWith(CODEX_CREDENTIAL_STORE_PIN_MARKER)) {
      continue
    }
    kept.push(line)
  }
  while (kept.length > 0 && (kept.at(-1) ?? '').trim() === '') {
    kept.pop()
  }
  return kept.length === 0 ? '' : joinPreservingTrailingNewline(kept, usesCrlf)
}
