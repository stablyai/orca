import { beforeEach, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { OrcaRuntimeService } from '../../orca-runtime'
import { AI_VAULT_METHODS } from './ai-vault'

const mocks = vi.hoisted(() => ({ list: vi.fn(), resolve: vi.fn() }))
vi.mock('../../../ipc/ai-vault-subagent-list', () => ({ listAiVaultSubagentSessions: mocks.list }))
vi.mock('../../../native-chat/session-file-resolver', () => ({
  resolveSessionFilePath: mocks.resolve
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.list.mockResolvedValue({ sessions: [], issues: [] })
  mocks.resolve.mockResolvedValue('/host/parent.jsonl')
})

function call(params: unknown) {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('host')
  return new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS }).dispatch({
    id: 'subagents',
    authToken: 'token',
    method: 'aiVault.listSubagentSessions',
    params
  })
}

it.each(['claude', 'openclaude', 'codex', 'grok', 'omp'])(
  'lists %s children using the owning host path',
  async (agent) => {
    expect(await call({ agent, parentFilePath: '/host/parent.jsonl' })).toMatchObject({ ok: true })
    expect(mocks.list).toHaveBeenCalledWith({
      agent: agent === 'openclaude' ? 'claude' : agent,
      parentFilePath: '/host/parent.jsonl'
    })
    expect(mocks.resolve).not.toHaveBeenCalled()
  }
)

it.each(['grok', 'omp'])(
  'resolves %s pathless hook sessions before applying the file boundary',
  async (agent) => {
    expect(await call({ agent, parentSessionId: 'parent' })).toMatchObject({ ok: true })
    expect(mocks.resolve).toHaveBeenCalledWith(agent, 'parent')
    expect(mocks.list).toHaveBeenCalledWith({ agent, parentFilePath: '/host/parent.jsonl' })
  }
)

it('does not list files when the provider has not persisted its session yet', async () => {
  mocks.resolve.mockResolvedValue(null)
  expect(await call({ agent: 'omp', parentSessionId: 'parent' })).toMatchObject({
    ok: true,
    result: { sessions: [] }
  })
  expect(mocks.list).not.toHaveBeenCalled()
})

it.each([
  { agent: 'omp' },
  { agent: 'unknown', parentFilePath: '/host/parent.jsonl' },
  { agent: 'grok', parentSessionId: '' }
])('rejects malformed lookup %j', async (params) => {
  expect(await call(params)).toMatchObject({ ok: false })
  expect(mocks.list).not.toHaveBeenCalled()
  expect(mocks.resolve).not.toHaveBeenCalled()
})
