import { expect, it, vi } from 'vitest'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { prepareStructuredAgentSessionCreateForWorktree } from './structured-agent-session-create'

const listing = (models: unknown[]) => ({ origin: 'probe', models })

async function prepareWithSeed(
  seed: Readonly<Record<string, string>> | undefined,
  options: Readonly<Record<string, string>> | undefined,
  listingModels: unknown[] | null
): Promise<AgentSessionAttachParams['options']> {
  const attachParams = {
    envelope: {
      sessionId: 'pi_session_1',
      clientOperationId: 'operation-1',
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'pi',
    agent: 'pi',
    accountHome: { variable: 'HOME', path: '/home/user' },
    runtimeKind: 'native' as const,
    ...(seed ? { options: seed } : {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements only the members prepare reaches.
  const host = {
    deps: {
      modelCatalog: listingModels ? { read: vi.fn(async () => listing(listingModels)) } : undefined
    }
  } as unknown as StructuredAgentSessionHost
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements only the members prepare reaches.
  const runtime = {
    resolveStructuredAgentSessionCreateIntent: vi.fn(async () => attachParams),
    resolveStructuredAgentSessionLocalWorkspacePath: vi.fn(async () => '/work/repo')
  } as unknown as OrcaRuntimeService
  const prepared = await prepareStructuredAgentSessionCreateForWorktree({
    runtime,
    ensureHost: async () => host,
    envelope: attachParams.envelope,
    worktree: 'id:workspace-1',
    agent: 'pi',
    caller: { callerKey: 'caller-1' },
    ...(options ? { options } : {})
  })
  return prepared.attachParams.options
}

const piRow = (efforts: readonly string[]) => ({
  id: 'some/model',
  label: 'Some Model',
  isDefault: false,
  efforts: efforts.map((value) => ({ value, label: value }))
})

it('moves a remembered effort the saved probe row lacks to its nearest listed level', async () => {
  // Pi's live menu offers xhigh where its --list-models probe stops at high.
  const options = await prepareWithSeed({ model: 'some/model', effort: 'xhigh' }, undefined, [
    piRow(['off', 'minimal', 'low', 'medium', 'high'])
  ])
  expect(options).toEqual({ model: 'some/model', effort: 'high' })
})

it('drops a remembered effort its saved row no longer admits', async () => {
  const options = await prepareWithSeed({ model: 'some/model', effort: 'off' }, undefined, [
    piRow([])
  ])
  expect(options).toEqual({ model: 'some/model' })
})

it('keeps an effort this launch named itself, even one its row does not admit', async () => {
  // Explicit options replace the saved selection; only their own values stay the caller's picks.
  const options = await prepareWithSeed({ model: 'some/model' }, { effort: 'off' }, [piRow([])])
  expect(options).toEqual({ effort: 'off' })
})

it('keeps a remembered effort when no saved rows name its model', async () => {
  const options = await prepareWithSeed({ model: 'some/model', effort: 'off' }, undefined, [
    { id: 'other/model', label: 'Other Model', isDefault: false, efforts: [] }
  ])
  expect(options).toEqual({ model: 'some/model', effort: 'off' })
})
