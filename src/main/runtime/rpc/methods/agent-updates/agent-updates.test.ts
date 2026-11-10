import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentUpdateRow,
  AgentUpdatesState
} from '../../../../../shared/agent-updates/agent-update-types'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcRequest } from '../../core'
import { RpcDispatcher } from '../../dispatcher'
import { AGENT_UPDATE_METHODS } from './agent-updates'

const service = vi.hoisted(() => {
  const state: AgentUpdatesState = { rows: [], checking: false, checkedAt: null }
  return { state, refreshAgentUpdates: vi.fn(), startAgentUpdates: vi.fn() }
})

vi.mock('../../../../agent-updates/agent-update-service', () => ({
  getAgentUpdatesState: () => service.state,
  refreshAgentUpdates: service.refreshAgentUpdates,
  startAgentUpdates: service.startAgentUpdates
}))

function createDispatcher(settings: Record<string, unknown>): RpcDispatcher {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods only read requireStore().getSettings; the dispatcher only reads getRuntimeId.
  const runtime = {
    getRuntimeId: () => 'runtime-a',
    requireStore: () => ({ getSettings: () => settings })
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: [...AGENT_UPDATE_METHODS] })
}

function call(dispatcher: RpcDispatcher, method: string, params?: unknown) {
  const request: RpcRequest = { id: method, authToken: 'token', method, params }
  return dispatcher.dispatch(request)
}

describe('agent update RPC methods', () => {
  beforeEach(() => {
    service.state = { rows: [], checking: false, checkedAt: null }
    service.refreshAgentUpdates.mockReset()
    service.startAgentUpdates.mockReset()
  })

  it('starts a check with the host settings and answers before it finishes', async () => {
    service.refreshAgentUpdates.mockImplementation(() => {
      service.state = { rows: [], checking: true, checkedAt: null }
      return new Promise(() => {})
    })
    const dispatcher = createDispatcher({ disabledTuiAgents: ['gemini'] })

    await expect(call(dispatcher, 'agentUpdates.refresh')).resolves.toMatchObject({
      ok: true,
      result: { rows: [], checking: true, checkedAt: null }
    })
    expect(service.refreshAgentUpdates).toHaveBeenCalledWith({
      disabledTuiAgents: ['gemini'],
      agentCmdOverrides: {}
    })
  })

  it('starts updates for the requested agents and answers before they finish', async () => {
    const running: AgentUpdateRow = {
      agent: 'codex',
      current: '0.166.0',
      latest: '0.167.0',
      updateAvailable: true,
      action: { kind: 'run' },
      run: { state: 'running' }
    }
    service.startAgentUpdates.mockImplementation(() => {
      service.state = { rows: [running], checking: false, checkedAt: 1 }
      return new Promise(() => {})
    })
    const dispatcher = createDispatcher({ agentCmdOverrides: { codex: '/opt/codex' } })

    await expect(
      call(dispatcher, 'agentUpdates.update', { agents: ['codex'] })
    ).resolves.toMatchObject({ ok: true, result: { rows: [running] } })
    expect(service.startAgentUpdates).toHaveBeenCalledWith(['codex'], {
      disabledTuiAgents: [],
      agentCmdOverrides: { codex: '/opt/codex' }
    })
  })

  it('refuses an agent outside the catalog without starting anything', async () => {
    const dispatcher = createDispatcher({})

    await expect(
      call(dispatcher, 'agentUpdates.update', { agents: ['rm -rf /'] })
    ).resolves.toMatchObject({ ok: false })
    expect(service.startAgentUpdates).not.toHaveBeenCalled()
  })
})
