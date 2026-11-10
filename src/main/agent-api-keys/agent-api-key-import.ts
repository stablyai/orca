// "Import from this Mac": main finds agent keys this computer already uses; the renderer only ever
// sees names, where each was found and the last four characters. Values are re-read here at import
// time and go straight into the sealed vault (and the Orca account when signed in).
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import {
  MAX_AGENT_API_KEY_IMPORT,
  type AgentApiKeyCloudOutcome,
  type AgentApiKeysImportResult,
  type AgentApiKeysScanResult
} from '../../shared/agent-api-keys/agent-api-key-cloud'
import type { AgentApiKeySummary } from '../../shared/agent-api-keys/agent-api-key-catalog'
import { AgentApiKeyError, type AgentApiKeyStore } from './agent-api-key-store'
import {
  SWAPPABLE_AGENT_KEY_NAMES,
  type LocalAgentCredentials,
  type LocalAgentKey,
  type SwappableAgentKeyName
} from './local-agent-credentials'

/** The vault agent an imported key belongs to: the tool whose file held it, else the CLI that reads it. */
const AGENT_BY_NAME: Record<SwappableAgentKeyName, TuiAgent> = {
  ANTHROPIC_API_KEY: 'claude',
  OPENAI_API_KEY: 'codex',
  GEMINI_API_KEY: 'gemini',
  GOOGLE_GENERATIVE_AI_API_KEY: 'opencode',
  CURSOR_API_KEY: 'cursor',
  AI_GATEWAY_API_KEY: 'opencode'
}

export function importAgentFor(key: Pick<LocalAgentKey, 'name' | 'source'>): TuiAgent {
  if (key.source === 'opencode-auth') {
    return 'opencode'
  }
  if (key.source === 'gemini-env-file') {
    return 'gemini'
  }
  return AGENT_BY_NAME[key.name]
}

function alreadySaved(keys: readonly AgentApiKeySummary[], agent: TuiAgent, name: string): boolean {
  return keys.some((key) => key.agent === agent && key.envName === name)
}

/** What the renderer may see of a scan: no value, no part of one beyond the last four. */
export function scanSummary(
  found: LocalAgentCredentials,
  saved: readonly AgentApiKeySummary[]
): AgentApiKeysScanResult {
  return {
    keys: found.keys.map((key) => {
      const agent = importAgentFor(key)
      return {
        name: key.name,
        agent,
        source: key.source,
        hint: key.value.slice(-4),
        alreadySaved: alreadySaved(saved, agent, key.name)
      }
    }),
    signIns: found.signIns.map(({ agent, provider }) => ({ agent, provider }))
  }
}

export function parseImportNames(raw: unknown): SwappableAgentKeyName[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_AGENT_API_KEY_IMPORT) {
    return null
  }
  const names = new Set<SwappableAgentKeyName>()
  for (const name of raw) {
    const known = SWAPPABLE_AGENT_KEY_NAMES.find((candidate) => candidate === name)
    if (!known) {
      return null
    }
    names.add(known)
  }
  return [...names]
}

/**
 * Saves the chosen names from a fresh scan. A name the vault already holds for that agent is left
 * alone (the user edits it instead), so an import never overwrites a key silently.
 */
export async function importLocalAgentKeys(input: {
  names: readonly SwappableAgentKeyName[]
  found: LocalAgentCredentials
  store: Pick<AgentApiKeyStore, 'list' | 'save'>
  push: (key: AgentApiKeySummary) => Promise<AgentApiKeyCloudOutcome>
}): Promise<Omit<AgentApiKeysImportResult, 'state'>> {
  const result: Omit<AgentApiKeysImportResult, 'state'> = {
    imported: [],
    failed: [],
    cloudFailed: []
  }
  for (const name of input.names) {
    const key = input.found.keys.find((entry) => entry.name === name)
    if (!key) {
      result.failed.push({
        name,
        error: 'Orca no longer finds this key on this computer.'
      })
      continue
    }
    const agent = importAgentFor(key)
    if (alreadySaved(await input.store.list(), agent, name)) {
      result.failed.push({
        name,
        error: 'Already saved. Edit the saved key to change it.'
      })
      continue
    }
    let saved: AgentApiKeySummary
    try {
      saved = await input.store.save({
        agent,
        envName: name,
        value: key.value,
        hostScope: { kind: 'all' }
      })
    } catch (error) {
      result.failed.push({
        name,
        error: error instanceof AgentApiKeyError ? error.message : 'Orca could not save the key.'
      })
      continue
    }
    result.imported.push(name)
    const cloud = await input.push(saved)
    if (cloud.kind === 'failed') {
      result.cloudFailed.push({ name, error: cloud.error })
    }
  }
  return result
}
