import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { observeAgentStateFile } from '../../configuration/codex-path-observation'
import { getSystemCodexHomePath } from '../../configuration/homes/codex-home-paths'
import { observeCodexSettingsBaseline } from '../../configuration/settings/config-settings-baseline'
import { readMcpServerTomlOwnership } from '../../configuration/toml/config-toml-mcp-servers'
import { CODEX_MCP_RPC_TIMEOUT_MS, type CodexMcpRequest } from './codex-mcp-server-status'

export function writeCodexMcpEnabled(
  request: CodexMcpRequest,
  server: string,
  enabled: boolean
): Promise<unknown> {
  return request(
    'config/batchWrite',
    {
      edits: [
        { keyPath: `mcp_servers.${server}.enabled`, value: enabled, mergeStrategy: 'upsert' }
      ],
      reloadUserConfig: true
    },
    { timeoutMs: CODEX_MCP_RPC_TIMEOUT_MS }
  )
}

/** A managed home re-mirrors servers declared in ~/.codex at every launch, so an `enabled` written
 *  only there is reverted; those servers take the write in ~/.codex too. */
export function codexMirrorSourceDeclaring(codexHome: string, server: string): string | null {
  const source = getSystemCodexHomePath()
  if (normalizeRuntimePathForComparison(codexHome) === normalizeRuntimePathForComparison(source)) {
    return null
  }
  const baseline = observeCodexSettingsBaseline(codexHome)
  if (baseline.kind === 'absent') {
    return null
  }
  const config = observeAgentStateFile(join(source, 'config.toml'))
  if (baseline.kind === 'indeterminate' || config.kind === 'indeterminate') {
    throw new Error("Orca couldn't read your Codex settings. Try again.")
  }
  if (config.kind === 'absent') {
    return null
  }
  const owner = readMcpServerTomlOwnership(config.value)
  return owner.ownsRoot || owner.names.has(server) ? source : null
}
