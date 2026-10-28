import { basename, dirname } from 'node:path'
import { codexConversationStore } from './codex-conversation-store-path'
import { parseTomlKeyPath } from './config-toml-key-path'
import { resolveEffectiveCodexSqliteHome } from './codex-sqlite-home'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

export const CODEX_SHARED_STORE_MARKER = '# orca: shared conversation store'

export function stripCodexSharedStoreConfig(config: string): string {
  return config
    .split('\n')
    .filter((line) => !line.trimEnd().endsWith(CODEX_SHARED_STORE_MARKER))
    .join('\n')
}

/** Only new overlay configs are ours to point at a conversation store. */
export function applyCodexSharedStoreConfig(config: string, homePath: string): string {
  if (basename(dirname(homePath)) !== 'overlays') {
    return config
  }
  const store = codexConversationStore(homePath)
  let state = createTomlLineScanState()
  let topLevel = true
  let removing = false
  const lines = stripCodexSharedStoreConfig(config)
    .split('\n')
    .filter((line) => {
      const structural = isTomlStructuralLine(state)
      if (structural) {
        removing = false
        if (getTomlTableHeader(line)) {
          topLevel = false
        }
        const key = topLevel ? parseTomlKeyPath(line) : null
        removing = !!(
          key &&
          key.segments.length === 1 &&
          ['sqlite_home', 'cli_auth_credentials_store'].includes(key.segments[0]) &&
          line[key.end] === '='
        )
      }
      state = updateTomlLineScanState(state, line)
      return !removing
    })
  return `sqlite_home = ${JSON.stringify(resolveEffectiveCodexSqliteHome(store))} ${CODEX_SHARED_STORE_MARKER}\ncli_auth_credentials_store = "file" ${CODEX_SHARED_STORE_MARKER}\n${lines.join('\n')}`
}
