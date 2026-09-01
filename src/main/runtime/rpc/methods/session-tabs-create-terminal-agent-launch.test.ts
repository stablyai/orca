import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TAB_METHODS } from './session-tabs'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const MOBILE_TAB_RESULT = {
  tab: {
    type: 'terminal',
    id: 'tab-1::leaf-1',
    parentTabId: 'tab-1',
    leafId: 'leaf-1',
    title: 'Terminal',
    status: 'ready',
    terminal: 'pty-1',
    isActive: true
  },
  publicationEpoch: 'epoch-1',
  snapshotVersion: 1
}

async function dispatchTabCreateWithClientKind(
  dispatcher: RpcDispatcher,
  params: unknown,
  clientKind?: 'mobile' | 'runtime'
): Promise<{ ok: boolean; result?: unknown }> {
  const messages: string[] = []
  await dispatcher.dispatchStreaming(
    makeRequest('session.tabs.createTerminal', params),
    (m) => messages.push(m),
    { clientKind }
  )
  return JSON.parse(messages[0]!)
}

describe('session.tabs.createTerminal host-resolved agentLaunch', () => {
  const AGENT_LAUNCH = { selection: { kind: 'agent', agent: 'claude' }, prompt: 'hi' }

  it('forwards agentLaunch + clientKind and returns the created tab', async () => {
    const createMobileSessionTerminal = vi.fn().mockResolvedValue(MOBILE_TAB_RESULT)
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatchTabCreateWithClientKind(
      dispatcher,
      { worktree: 'id:wt-1', command: 'evil --client-controlled', agentLaunch: AGENT_LAUNCH },
      'mobile'
    )

    expect(response.ok).toBe(true)
    expect(createMobileSessionTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ agentLaunch: AGENT_LAUNCH, clientKind: 'mobile' })
    )
    expect(response.result).toMatchObject({ tab: { id: 'tab-1::leaf-1' } })
  })

  it('admits a custom agent id on the sanctioned agentLaunch selection', async () => {
    const customId = 'custom-agent:codex:11111111-1111-4111-8111-111111111111'
    const customLaunch = {
      selection: { kind: 'agent', agent: customId },
      allowEmptyPromptLaunch: true
    }
    const createMobileSessionTerminal = vi.fn().mockResolvedValue(MOBILE_TAB_RESULT)
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatchTabCreateWithClientKind(
      dispatcher,
      { worktree: 'id:wt-1', agentLaunch: customLaunch },
      'mobile'
    )

    expect(response.ok).toBe(true)
    expect(createMobileSessionTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ agentLaunch: customLaunch })
    )
  })

  it('rejects a custom agent id on the legacy built-in-only preset fields', async () => {
    const customId = 'custom-agent:codex:11111111-1111-4111-8111-111111111111'
    const createMobileSessionTerminal = vi.fn().mockResolvedValue(MOBILE_TAB_RESULT)
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    // Contract: a custom id is only admitted on agentLaunch.selection; the legacy
    // `agent`/`launchAgent` fields fail fast instead of failing deep in the
    // built-in-only startup plan.
    for (const params of [
      { worktree: 'id:wt-1', agent: customId },
      { worktree: 'id:wt-1', launchAgent: customId }
    ]) {
      const response = await dispatchTabCreateWithClientKind(dispatcher, params, 'mobile')
      expect(response.ok).toBe(false)
    }
    expect(createMobileSessionTerminal).not.toHaveBeenCalled()
  })

  it('returns the failure arm as an RPC success with no tab created', async () => {
    const createMobileSessionTerminal = vi.fn().mockResolvedValue({
      agentLaunch: {
        status: 'failed',
        failure: { code: 'base_agent_disabled', baseAgent: 'claude' }
      }
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatchTabCreateWithClientKind(
      dispatcher,
      { worktree: 'id:wt-1', agentLaunch: AGENT_LAUNCH },
      'runtime'
    )

    expect(response.ok).toBe(true)
    expect(response.result).toEqual({
      agentLaunch: {
        status: 'failed',
        failure: { code: 'base_agent_disabled', baseAgent: 'claude' }
      }
    })
    expect(response.result).not.toHaveProperty('tab')
  })
})
