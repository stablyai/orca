import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'

import type { ExecutionHostId } from '../../../../shared/execution-host'
import { savedChatNamingCatalog } from '../../../../shared/chat-naming-catalog-work.test-fixture'
import type { SpawnSourceControlAgent } from '../../../text-generation/source-control-text-generation-types'

import { structuredChatNamingDeps } from './structured-chat-naming-runtime'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'

import type * as OwnedOpenCodeTask from '../../../opencode/text-tasks/opencode-owned-text-task'

const boundary = vi.hoisted(() => ({
  spawn: vi.fn<SpawnSourceControlAgent>(),
  native: vi.fn<NonNullable<StructuredAgentSessionAdapter['generateText']>>(),
  openCode: vi.fn(
    async (_input: { cwd: string; env?: NodeJS.ProcessEnv; prompt: string }) => 'Owned title'
  ),
  account: vi.fn((_provider: string, id: string) => ({
    XDG_DATA_HOME: `/profiles/${id}/data`,
    XDG_STATE_HOME: `/profiles/${id}/state`
  }))
}))
vi.mock('../../../opencode/text-tasks/opencode-owned-text-task', async (importOriginal) => ({
  ...(await importOriginal<typeof OwnedOpenCodeTask>()),
  runOwnedOpenCodeTextTask: boundary.openCode
}))
vi.mock('../../../text-generation/source-control-agent-launch', () => ({
  spawnSourceControlAgent: boundary.spawn
}))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ deps: { adapter: { generateText: boundary.native } } })
}))
vi.mock('../../../managed-data-accounts/service', () => ({
  getManagedDataAccountService: () => ({
    restoreOriginalEnvironment: () => {},
    environmentForAccount: boundary.account
  })
}))
beforeEach(() => {
  vi.clearAllMocks()
  boundary.spawn.mockReset()
  boundary.native.mockReset()
  boundary.openCode.mockClear()
  vi.stubEnv('ORCA_PI_SOURCE_AGENT_DIR', undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function rig() {
  const settings = getDefaultSettings('/isolated')
  settings.defaultTuiAgent = 'codex'
  settings.sourceControlAi = savedChatNamingCatalog(0)
  const env = {
    PATH: '/usr/bin',
    PI_CODING_AGENT_DIR: '/configured/pi',
    OPENCODE_CONFIG_DIR: '/configured/oc',
    OPENCODE_AUTH_CONTENT: 'current-account-sentinel'
  }
  const runtime = {
    resolveWorkspace: vi.fn(
      async (): Promise<{ path: string; executionHostId: ExecutionHostId }> => ({
        path: '/workspace/folder',
        executionHostId: 'local'
      })
    ),
    resolveNamingEnvironment: vi.fn(async () => env),
    getAgentEnvResolvers: () => ({ resolveBaseEnvironment: async () => env }),
    workerTaskTitle: () => null,
    retitleOpenTab: () => {}
  }
  return {
    settings,
    runtime,
    deps: structuredChatNamingDeps(() => ({ getSettings: () => settings }), runtime, {
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}

it.each(['opencode', 'opencode2'] as const)(
  'routes %s naming into the owned task with its selected account',
  async (provider) => {
    const state = rig()
    const record = agentSessionRecordFixture()
    record.provider = provider
    record.accountHome = {
      kind: 'opencode',
      locator: { kind: 'managed', managedProfileId: 'recorded' }
    }
    expect(await state.deps.generate(record, 'Repair login')).toEqual({ name: 'Owned title' })
    expect(boundary.openCode).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/workspace/folder',
        prompt: expect.stringContaining('Repair login'),
        env: expect.objectContaining({
          XDG_DATA_HOME: '/profiles/recorded/data',
          XDG_STATE_HOME: '/profiles/recorded/state',
          OPENCODE_AUTH_CONTENT: undefined
        })
      })
    )
    expect(boundary.spawn).not.toHaveBeenCalled()
    expect(boundary.account).toHaveBeenCalledWith('opencode', 'recorded')
  }
)
