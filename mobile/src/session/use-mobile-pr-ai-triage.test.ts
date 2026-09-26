import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'

vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))

import { useMobilePrAiTriage, type MobilePrAiTriage } from './use-mobile-pr-ai-triage'

const LAUNCH_CAPABILITIES = [
  'agent.launch.v2',
  'agent.launch.replay.v1',
  'agent.launch.replay-required.v1'
]

function rpcReply(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'r' } }
}

const LAUNCHED_WITHOUT_PROMPT = rpcReply({
  outcome: { kind: 'terminal', handle: 'term-1' },
  worktreeId: 'wt-1',
  receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'd' },
  prompt: { delivery: 'submit', outcome: 'not-delivered' }
})

function hostClient(): RpcClient {
  const sendRequest = vi.fn(async (method: string): Promise<RpcResponse> => {
    if (method === 'repo.list') {
      return rpcReply({ repos: [{ id: 'wt-1' }] })
    }
    if (method === 'settings.get') {
      return rpcReply({ settings: { defaultTuiAgent: 'codex' } })
    }
    if (method === 'preflight.detectAgents') {
      return rpcReply(['codex'])
    }
    return LAUNCHED_WITHOUT_PROMPT
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reaches the client only through sendRequest.
  return { sendRequest } as unknown as RpcClient
}

describe('useMobilePrAiTriage', () => {
  let renderer: ReactTestRenderer | null = null
  let triage: MobilePrAiTriage | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    triage = null
  })

  function mount(client: RpcClient | null, connState: ConnectionState = 'connected') {
    function Harness(): null {
      triage = useMobilePrAiTriage({
        client,
        connState,
        worktreeId: 'wt-1',
        hostCapabilities: LAUNCH_CAPABILITIES,
        hostStatusPending: false,
        hostStatusReadable: true
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
  }

  it('shows an undelivered prompt only under the button that launched it', async () => {
    mount(hostClient())
    await act(async () => {
      await triage?.launch('fix-checks', () => 'fix the failing checks')
    })
    expect(triage?.noticeFor('fix-checks')).toMatchObject({
      error: "The agent started, but the prompt wasn't sent."
    })
    expect(triage?.noticeFor('fix-checks').undeliveredPrompt).toContain('fix the failing checks')
    expect(triage?.noticeFor('resolve-conflicts')).toEqual({
      error: null,
      warning: null,
      undeliveredPrompt: null
    })
  })

  it('shows a refusal before launch only under the tapped button', async () => {
    mount(null, 'disconnected')
    await act(async () => {
      await triage?.launch('resolve-conflicts', () => 'resolve')
    })
    expect(triage?.noticeFor('resolve-conflicts').error).toBe('Waiting for desktop…')
    expect(triage?.noticeFor('fix-checks').error).toBeNull()
  })
})
