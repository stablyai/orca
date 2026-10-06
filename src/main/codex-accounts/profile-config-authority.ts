import { AgentProfilePreparationError } from '../agent-profiles/preparation-error'
import {
  parseTomlStringValue,
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from '../codex/config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from '../codex/config-toml-key-path'
// A managed OAuth profile must keep its per-account auth.json as credential authority.
import { join } from 'node:path'
import { observeAgentStateFile } from '../codex/codex-path-observation'
import { readCodexTopLevelModelProvider } from '../codex/codex-model-provider-config'
import { scanStructuredSettingLines } from '../codex/config-toml-promoted-setting-values'

export function assertCodexProfileConfigAuthority(home: string): void {
  assertCodexProfileConfigFileAuthority(join(home, 'config.toml'))
}
export function assertCodexProfileConfigFileAuthority(path: string): void {
  const observed = observeAgentStateFile(path)
  if (observed.kind === 'absent') {
    return
  }
  if (observed.kind !== 'present') {
    throw new AgentProfilePreparationError('codex_config')
  }
  let scan = createTomlLineScanState()
  let table: string[] = []
  for (const line of observed.value.split('\n')) {
    const structural = isTomlStructuralLine(scan)
    scan = updateTomlLineScanState(scan, line)
    if (!structural) {
      continue
    }
    const header = getTomlTableHeader(line)
    if (header) {
      table = parseTomlTableHeaderPath(header)?.segments ?? []
      continue
    }
    const key = parseTomlKeyPath(line)
    if (!key || line[key.end] !== '=') {
      continue
    }
    const parts = [...table, ...key.segments]
    if (
      ['openai_base_url', 'chatgpt_base_url', 'experimental_realtime_ws_base_url'].includes(
        parts[0]
      ) ||
      (parts[0] === 'model_providers' && (parts.length === 1 || parts[1] === 'openai'))
    ) {
      throw new AgentProfilePreparationError('codex_config')
    }
  }
  const provider = readCodexTopLevelModelProvider(observed.value)
  if (provider && provider !== 'openai') {
    throw new AgentProfilePreparationError('codex_config')
  }
  for (const setting of scanStructuredSettingLines(observed.value.split('\n'))) {
    const key = setting.structuredKey
    if (
      ![
        'cli_auth_credentials_store',
        'forced_login_method',
        'profile',
        'model_provider',
        'forced_chatgpt_workspace_id'
      ].includes(key)
    ) {
      continue
    }
    const value = setting.multiline ? undefined : parseTomlStringValue(setting.raw, 0)?.value
    // File is the CLI default; auto can prefer the keyring and ephemeral ignores disk credentials.
    const compatible =
      key === 'cli_auth_credentials_store'
        ? value === 'file'
        : key === 'forced_login_method'
          ? value === 'chatgpt'
          : key === 'model_provider'
            ? value === 'openai'
            : false
    if (!compatible) {
      throw new AgentProfilePreparationError('codex_config')
    }
  }
}

export const CODEX_PROFILE_FILE_AUTH_ARGS = ['-c', 'cli_auth_credentials_store="file"'] as const
