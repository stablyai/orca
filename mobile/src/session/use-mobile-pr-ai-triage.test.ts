import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'

vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))

import { useMobilePrAiTriage, type MobilePrAiTriage } from './use-mobile-pr-ai-triage'
import { stubRpcClient } from '../transport/rpc-client-test-stub'

const LAUNCH_CAPABILITIES = [
  'agent.launch.v2',
  'agent.launch.replay.v1',
  'agent.launch.replay-required.v1'
]

function rpcReply(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'r' } }
}

const LAUNCHED_WITH_PROMPT = rpcReply({
  outcome: { kind: 'terminal', handle: 'term-1' },
  worktreeId: 'wt-1',
  receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'd' },
  prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
})

const LAUNCHED_WITHOUT_PROMPT = rpcReply({
  outcome: { kind: 'terminal', handle: 'term-1' },
  worktreeId: 'wt-1',
  receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'd' },
  prompt: { delivery: 'submit', outcome: 'not-delivered' }
})

function hostClient(
  launchReply: RpcResponse | Promise<RpcResponse> = LAUNCHED_WITHOUT_PROMPT
): RpcClient {
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
    return launchReply
  })
  return stubRpcClient({ sendRequest })
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
    function Harness(props: { client: RpcClient | null; worktreeId: string }): null {
      triage = useMobilePrAiTriage({
        client: props.client,
        connState,
        worktreeId: props.worktreeId,
        hostCapabilities: LAUNCH_CAPABILITIES,
        hostStatusPending: false,
        hostStatusReadable: true
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness, { client, worktreeId: 'wt-1' }))
    })
    return (nextClient: RpcClient | null, worktreeId: string) =>
      act(() => renderer?.update(createElement(Harness, { client: nextClient, worktreeId })))
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
    expect(triage?.noticeFor('fix-checks').launch).toMatchObject({
      outcome: { kind: 'terminal', handle: 'term-1' }
    })
    expect(triage?.noticeFor('resolve-conflicts')).toEqual({
      launch: null,
      error: null,
      undeliveredPrompt: null
    })
  })

  it('retains the launched surface only under the tapped button', async () => {
    mount(hostClient(LAUNCHED_WITH_PROMPT))
    await act(async () => {
      await triage?.launch('resolve-conflicts', () => 'resolve the conflicts')
    })
    expect(triage?.noticeFor('resolve-conflicts')).toEqual({
      launch: LAUNCHED_WITH_PROMPT.ok ? LAUNCHED_WITH_PROMPT.result : null,
      error: null,
      undeliveredPrompt: null
    })
    expect(triage?.noticeFor('fix-checks').launch).toBeNull()
  })

  it('shows a refusal before launch only under the tapped button', async () => {
    mount(null, 'disconnected')
    await act(async () => {
      await triage?.launch('resolve-conflicts', () => 'resolve')
    })
    expect(triage?.noticeFor('resolve-conflicts').error).toBe('Waiting for desktop…')
    expect(triage?.noticeFor('fix-checks').error).toBeNull()
  })

  it.each(['workspace', 'host'] as const)(
    'does not offer the previous launch after the %s changes',
    async (changed) => {
      const client = hostClient()
      const rerender = mount(client)
      await act(async () => {
        await triage?.launch('fix-checks', () => 'fix the failing checks')
      })
      expect(triage?.noticeFor('fix-checks').launch).not.toBeNull()

      rerender(
        changed === 'host' ? hostClient() : client,
        changed === 'workspace' ? 'wt-2' : 'wt-1'
      )
      expect(triage?.noticeFor('fix-checks')).toEqual({
        launch: null,
        error: null,
        undeliveredPrompt: null
      })
    }
  )

  it.each(['workspace', 'host'] as const)(
    'keeps a pending launch attached to its original %s',
    async (changed) => {
      const reply = Promise.withResolvers<RpcResponse>()
      const client = hostClient(reply.promise)
      const rerender = mount(client)
      let launched: Promise<boolean> | undefined
      await act(async () => {
        launched = triage?.launch('fix-checks', () => 'fix the failing checks')
      })
      rerender(
        changed === 'host' ? hostClient() : client,
        changed === 'workspace' ? 'wt-2' : 'wt-1'
      )
      await act(async () => {
        reply.resolve(LAUNCHED_WITHOUT_PROMPT)
        expect(await launched).toBe(false)
      })
      expect(triage?.noticeFor('fix-checks')).toEqual({
        launch: null,
        error: null,
        undeliveredPrompt: null
      })

      rerender(client, 'wt-1')
      expect(triage?.noticeFor('fix-checks').undeliveredPrompt).toContain('fix the failing checks')
    }
  )

  it('starts only one agent for same-frame taps on different triage actions', async () => {
    mount(hostClient(LAUNCHED_WITH_PROMPT))
    const buildPrompt = vi.fn(() => 'fix the failing checks')
    const launch = triage?.launch
    await act(async () => {
      expect(
        await Promise.all([
          launch?.('fix-checks', buildPrompt),
          launch?.('resolve-conflicts', buildPrompt)
        ])
      ).toEqual([true, false])
    })
    expect(buildPrompt).toHaveBeenCalledOnce()
    expect(triage?.isBusy('fix-checks')).toBe(false)
    expect(triage?.noticeFor('resolve-conflicts').launch).toBeNull()
  })
})
