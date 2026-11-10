import { describe, expect, it, vi } from 'vitest'
import type {
  AgentApiKeySaveRequest,
  AgentApiKeySummary
} from '../../shared/agent-api-keys/agent-api-key-catalog'
import { CLOUD_SWAPPED_CREDENTIALS } from '../../shared/cloud-secrets/cloud-secret-rules'
import { importLocalAgentKeys, parseImportNames, scanSummary } from './agent-api-key-import'
import { AgentApiKeyError } from './agent-api-key-store'
import { SWAPPABLE_AGENT_KEY_NAMES, type LocalAgentCredentials } from './local-agent-credentials'

const OPENAI = 'sk-proj-import-secret-value-a1B2'
const GATEWAY = 'vck_import_secret_value_gw90'
const GEMINI = 'AIzaSy-import-secret-value-Zk19'

const FOUND: LocalAgentCredentials = {
  keys: [
    { name: 'OPENAI_API_KEY', value: OPENAI, source: 'shell-env' },
    { name: 'AI_GATEWAY_API_KEY', value: GATEWAY, source: 'opencode-auth' },
    { name: 'GEMINI_API_KEY', value: GEMINI, source: 'gemini-env-file' }
  ],
  signIns: [{ agent: 'opencode', provider: 'anthropic' }]
}

function summary(request: AgentApiKeySaveRequest, id: string): AgentApiKeySummary {
  return {
    id,
    agent: request.agent,
    envName: request.envName,
    hostScope: request.hostScope,
    hint: request.value?.slice(-4) ?? '',
    updatedAt: 1
  }
}

describe('scanSummary', () => {
  it('gives the renderer names, sources and last fours, never a value', () => {
    const saved = [
      summary({ agent: 'gemini', envName: 'GEMINI_API_KEY', hostScope: { kind: 'all' } }, 'g')
    ]
    const result = scanSummary(FOUND, saved)
    expect(result).toEqual({
      keys: [
        {
          name: 'OPENAI_API_KEY',
          agent: 'codex',
          source: 'shell-env',
          hint: 'a1B2',
          alreadySaved: false
        },
        {
          name: 'AI_GATEWAY_API_KEY',
          agent: 'opencode',
          source: 'opencode-auth',
          hint: 'gw90',
          alreadySaved: false
        },
        {
          name: 'GEMINI_API_KEY',
          agent: 'gemini',
          source: 'gemini-env-file',
          hint: 'Zk19',
          alreadySaved: true
        }
      ],
      signIns: [{ agent: 'opencode', provider: 'anthropic' }]
    })
    const wire = JSON.stringify(result)
    for (const value of [OPENAI, GATEWAY, GEMINI]) {
      expect(wire).not.toContain(value)
      expect(wire).not.toContain(value.slice(0, -4))
    }
  })

  it('only offers names the egress proxy swaps', () => {
    for (const name of SWAPPABLE_AGENT_KEY_NAMES) {
      expect(CLOUD_SWAPPED_CREDENTIALS).toContain(name)
    }
  })
})

describe('parseImportNames', () => {
  it('accepts known swappable names only', () => {
    expect(parseImportNames(['OPENAI_API_KEY', 'OPENAI_API_KEY'])).toEqual(['OPENAI_API_KEY'])
    expect(parseImportNames(['PATH'])).toBeNull()
    expect(parseImportNames('OPENAI_API_KEY')).toBeNull()
    expect(parseImportNames([])).toBeNull()
  })
})

describe('importLocalAgentKeys', () => {
  it('saves chosen keys for every host, pushes each to the account, and skips saved ones', async () => {
    const saved: AgentApiKeySummary[] = [
      summary({ agent: 'gemini', envName: 'GEMINI_API_KEY', hostScope: { kind: 'all' } }, 'g')
    ]
    const store = {
      list: async () => saved,
      save: vi.fn(async (request: AgentApiKeySaveRequest) => {
        const next = summary(request, `id-${saved.length}`)
        saved.push(next)
        return next
      })
    }
    const push = vi.fn(async (key: AgentApiKeySummary) =>
      key.envName === 'AI_GATEWAY_API_KEY'
        ? ({ kind: 'failed', error: 'unavailable', keyId: key.id } as const)
        : ({ kind: 'synced' } as const)
    )
    const result = await importLocalAgentKeys({
      names: ['OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'GEMINI_API_KEY'],
      found: FOUND,
      store,
      push
    })
    expect(store.save).toHaveBeenCalledWith({
      agent: 'codex',
      envName: 'OPENAI_API_KEY',
      value: OPENAI,
      hostScope: { kind: 'all' }
    })
    expect(result).toEqual({
      imported: ['OPENAI_API_KEY', 'AI_GATEWAY_API_KEY'],
      failed: [
        { name: 'GEMINI_API_KEY', error: 'Already saved. Edit the saved key to change it.' }
      ],
      cloudFailed: [{ name: 'AI_GATEWAY_API_KEY', error: 'unavailable' }]
    })
    expect(push).toHaveBeenCalledTimes(2)
  })

  it('reports vault errors with Orca copy only, and a name no longer found', async () => {
    const store = {
      list: async () => [],
      save: vi.fn(async () => {
        throw new Error(`boom ${OPENAI}`)
      })
    }
    const result = await importLocalAgentKeys({
      names: ['OPENAI_API_KEY', 'CURSOR_API_KEY'],
      found: FOUND,
      store,
      push: async () => ({ kind: 'synced' })
    })
    expect(result.failed).toEqual([
      { name: 'OPENAI_API_KEY', error: 'Orca could not save the key.' },
      { name: 'CURSOR_API_KEY', error: 'Orca no longer finds this key on this computer.' }
    ])
    expect(JSON.stringify(result)).not.toContain(OPENAI)
    store.save.mockRejectedValueOnce(new AgentApiKeyError('Keys are a single line.'))
    const again = await importLocalAgentKeys({
      names: ['OPENAI_API_KEY'],
      found: FOUND,
      store,
      push: async () => ({ kind: 'synced' })
    })
    expect(again.failed).toEqual([{ name: 'OPENAI_API_KEY', error: 'Keys are a single line.' }])
  })
})
