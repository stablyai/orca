import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  return agentSessionRecordFixture({
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
  })
}

async function afterNoPickChat(
  agent: string,
  workspacePath: string,
  picked = false,
  inspectWorkspace = workspaceMayOverrideDefaultModel
) {
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
      origin: 'probe'
    },
    'discovery'
  )
  const catalog = createAgentModelCatalogService({
    store,
    getConversation: (sessionId) => {
      const saved = sessionId === chat.sessionId ? chat : undefined
      return saved ? agentSessionConversationView(saved) : undefined
    },
    getRecord: (sessionId) => (sessionId === chat.sessionId ? chat : undefined),
    drivesRecord: () => true,
    resolveAccountHome: async () => HOMES[agent]!,
    recordWorkspacePath: async (row) => row.launchDirectory ?? null,
    agentReadsProjectModelConfig,
    workspaceMayOverrideDefaultModel: inspectWorkspace
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
      const learningStarted = Promise.withResolvers<void>()
      const releaseLearning = Promise.withResolvers<void>()
      let firstInspection = true
      const catalog = await afterNoPickChat(agent, clean, false, async (input) => {
        if (firstInspection) {
          firstInspection = false
          learningStarted.resolve()
          await releaseLearning.promise
        }
        return workspaceMayOverrideDefaultModel(input)
      })
      await learningStarted.promise
      try {
        const pending = await catalog.read({ agent, workspacePath: clean, waitForListing: true })
        expect(named(pending)).toBeNull()
      } finally {
        releaseLearning.resolve()
      }
      await vi.waitFor(() => {
        expect(named(catalog.snapshot({ agent, workspacePath: clean }))).toBe(
          'github-copilot/claude-fable-5'
        )
      })
      const answer = catalog.snapshot({ agent, workspacePath: clean })
      // Project config can override this default; do not promote it to every workspace.
      expect(answer).not.toHaveProperty('defaultHoldsInEveryWorkspace')
      expect(
        named(
          await catalog.read({ agent, workspacePath: workspace('other'), waitForListing: true })
        )
      ).toBe('github-copilot/claude-fable-5')
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
