import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentSessionAccountHome,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import { AcpStructuredOptions } from '../../acp/acp-structured-options'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { AgentModelCatalogStore, withLiveCatalogListing } from './agent-model-catalog-store'
import {
  agentReadsProjectModelConfig,
  workspaceMayOverrideDefaultModel
} from './agent-project-model-override'

// OpenCode and OMP list no default. A chat started with no pick in a workspace whose own config
// picks nothing runs the account's default, so the host names it for the next new chat there.

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-learned-default-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const HOMES: Record<string, AgentSessionAccountHome> = {
  opencode: { kind: 'opencode', locator: { kind: 'unmanaged' } },
  omp: { variable: 'PI_CODING_AGENT_DIR', path: '/homes/omp' }
}

const MODELS = [
  { value: 'github-copilot/gpt-6', name: 'GPT-6' },
  { value: 'github-copilot/claude-fable-5', name: 'Claude Fable 5' }
]

function workspace(name: string, files: Record<string, string> = {}): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere')
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

function record(agent: string, workspacePath: string): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the catalog service reads only these fields.
  return {
    sessionId: `${agent}-1`,
    provider: agent,
    accountHome: HOMES[agent]!,
    launchDirectory: workspacePath,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'ws-1',
      workspaceKind: 'git-worktree'
    }
  } as AgentSessionRecord
}

/** A host whose saved list names no default, and one chat started with no pick in `workspacePath`
 *  that reports what it runs. */
async function afterNoPickChat(agent: string, workspacePath: string, picked = false) {
  const chat = record(agent, workspacePath)
  const store = new AgentModelCatalogStore()
  store.recordSuccess(
    agentModelCatalogFingerprintForRecord(chat),
    agent,
    {
      models: MODELS.map((model) => ({
        id: model.value,
        label: model.name,
        isDefault: false,
        efforts: []
      })),
      fastModeTierByModel: new Map(),
      origin: 'probe'
    },
    'discovery'
  )
  const catalog = createAgentModelCatalogService({
    store,
    getRecord: (sessionId) => (sessionId === chat.sessionId ? chat : undefined),
    drivesRecord: () => true,
    resolveAccountHome: async () => HOMES[agent]!,
    recordWorkspacePath: async (row) => row.launchDirectory ?? null,
    agentReadsProjectModelConfig,
    workspaceMayOverrideDefaultModel
  })
  const options = new AcpStructuredOptions()
  options.adoptSession(
    {
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'github-copilot/claude-fable-5',
          options: MODELS
        }
      ]
    },
    'new'
  )
  if (picked) {
    options.notePick('model')
  }
  catalog.recordLiveListing(
    chat.sessionId,
    withLiveCatalogListing(options.read(), options.configuredDefault()).catalogListing
  )
  return catalog
}

function named(
  answer: Awaited<ReturnType<ReturnType<typeof createAgentModelCatalogService>['read']>>
) {
  return answer.origin === 'unknown' || answer.listingNamesConfiguredModel !== true
    ? null
    : (answer.models.find((model) => model.isDefault)?.id ?? null)
}

describe('a default learned from a chat with no pick', () => {
  it.each(['opencode', 'omp'])(
    '%s: the next new chat in that workspace names the model the first one ran',
    async (agent) => {
      const clean = workspace('clean')
      const catalog = await afterNoPickChat(agent, clean)
      const answer = await catalog.read({ agent, workspacePath: clean })
      expect(named(answer)).toBe('github-copilot/claude-fable-5')
      // Its own project config may still pick the model, so it is not every workspace's.
      expect(answer).not.toHaveProperty('defaultHoldsInEveryWorkspace')
      expect(named(await catalog.read({ agent, workspacePath: workspace('other') }))).toBe(
        'github-copilot/claude-fable-5'
      )
    }
  )

  it.each([
    ['opencode', 'opencode.json', '{"model":"github-copilot/claude-fable-5"}'],
    ['omp', '.omp/config.yml', 'modelRoles:\n  default: github-copilot/claude-fable-5\n']
  ])(
    '%s: a chat whose workspace config picks the model teaches nothing',
    async (agent, file, text) => {
      const configured = workspace('configured', { [file]: text })
      const catalog = await afterNoPickChat(agent, configured)
      expect(named(await catalog.read({ agent, workspacePath: workspace('clean') }))).toBeNull()
    }
  )

  it('a new chat in a workspace whose config picks the model names none', async () => {
    const catalog = await afterNoPickChat('opencode', workspace('clean'))
    const configured = workspace('configured', { 'opencode.json': '{"model":"x/y"}' })
    expect(named(await catalog.read({ agent: 'opencode', workspacePath: configured }))).toBeNull()
  })

  it('a chat that picked its model teaches nothing', async () => {
    const clean = workspace('clean')
    const catalog = await afterNoPickChat('opencode', clean, true)
    expect(named(await catalog.read({ agent: 'opencode', workspacePath: clean }))).toBeNull()
  })
})
