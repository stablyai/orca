import { describe, expect, it, vi } from 'vitest'
import {
  createAgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import {
  createHookListenerState,
  clearPaneCacheState
} from '../../shared/agent-hook-listener/listener-state'
import { cacheRelayLegacyAgentStatus } from '../../shared/agent-status-legacy-relay-cache'
import { makePaneKey } from '../../shared/stable-pane-id'

describe('session selection without declared roles', () => {
  it('allows a declaration to replace a startup-order guess', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const guessed = {
      sessionManager: { getSessionId: () => 'early', getSessionFile: () => '/early.jsonl' }
    }
    await harness.callHook('session_start', {}, guessed)
    const declared = harness.registerSession()
    const main = {
      agent: { kind: 'main' as const },
      sessionManager: { getSessionId: () => 'lead', getSessionFile: () => '/lead.jsonl' }
    }
    await declared.callHook('session_start', {}, main)
    await declared.callHook('agent_start', {}, main)
    await vi.waitFor(() =>
      expect(
        JSON.parse(String(harness.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload.session_id
      ).toBe('lead')
    )
    const count = harness.fetchMock.mock.calls.length
    await harness.callHook('agent_end', {}, guessed)
    const undeclared = harness.registerSession()
    await undeclared.callHook('session_switch', {}, guessed)
    expect(harness.fetchMock).toHaveBeenCalledTimes(count)
  })

  it('prunes sequential dead Pi sources at each open and never replays their history on final close', async () => {
    const context = (id: string, file?: string): HookContext => ({
      sessionManager: { getSessionId: () => id, getSessionFile: () => file },
      isIdle: () => true
    })
    const receiverEnv = {
      ORCA_TAB_ID: 'source-lifetime',
      ORCA_PANE_KEY: makePaneKey('source-lifetime', '44444444-4444-4444-8444-444444444444'),
      ORCA_AGENT_HOOK_ENV: 'production',
      ORCA_AGENT_HOOK_VERSION: '1'
    }
    const flush = () => vi.advanceTimersByTimeAsync(0)
    vi.useFakeTimers()
    try {
      for (const n of [10, 100]) {
        let visits = 0
        let staleProbes = 0
        const state = createHookListenerState()
        let admitted: ReturnType<typeof normalizeHookPayload> | undefined
        const h = createAgentStatusExtensionHarness({
          kind: 'pi',
          argv: ['node', '/usr/bin/pi'],
          existsSync: () => true,
          env: receiverEnv,
          onMapEntry: () => visits++,
          fetchImpl: async (_url, init) => {
            admitted = normalizeHookPayload(
              state,
              'pi',
              JSON.parse(String(init?.body)),
              'production'
            )
            if (admitted) {
              expect(
                cacheRelayLegacyAgentStatus(state, admitted, 16, (pane) =>
                  clearPaneCacheState(state, pane)
                )
              ).toBe(true)
            }
            return { ok: true }
          }
        })
        const root = context('lead', '/lead.jsonl')
        await h.callHook('session_start', {}, root)
        await h.callHook('agent_start', {}, root)
        const open = async (i: number) => {
          const child = h.registerSession()
          let disposed = false
          const manager = context('same-sdk-id').sessionManager
          const ctx: HookContext = {
            isIdle: () => true,
            get sessionManager() {
              if (disposed) {
                staleProbes++
                throw new Error('Extension context is no longer active')
              }
              return manager
            }
          }
          await child.callHook('session_start', {}, ctx)
          for (const name of ['tool_call', 'tool_execution_start']) {
            await child.callHook(
              name,
              {
                toolName: 'ask_user_question',
                toolCallId: `sdk-${i}`,
                [name === 'tool_call' ? 'input' : 'args']: {
                  questions: [{ id: 'choice', question: `Request ${i}?`, options: ['yes', 'no'] }]
                }
              },
              ctx
            )
          }
          return {
            child,
            ctx,
            dispose: () => {
              disposed = true
            }
          }
        }
        for (let i = 0; i < n; i++) {
          const before = visits
          const previousProbes = staleProbes
          const source = await open(i)
          // Each real call/start pair visits at most one old source plus one live record twice.
          expect(visits - before).toBeLessThanOrEqual(5)
          expect(staleProbes - previousProbes).toBe(i === 0 ? 0 : 1)
          source.dispose()
        }
        const live = await open(n)
        expect(staleProbes).toBe(n)
        const beforeOrdinary = visits
        await h.callHook('before_agent_start', { prompt: 'Lead prompt' }, root)
        await h.callHook('agent_start', {}, root)
        await h.callHook(
          'message_end',
          { message: { role: 'assistant', content: 'Lead answer' } },
          root
        )
        await h.callHook('agent_end', {}, root)
        await flush()
        expect(visits).toBe(beforeOrdinary)
        expect(admitted).toMatchObject({
          providerSession: { id: 'lead' },
          hookEventName: 'agent_end',
          payload: { state: 'blocked', prompt: 'Lead prompt', lastAssistantMessage: 'Lead answer' }
        })
        expect(
          JSON.parse(String(h.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload.hook_event_name
        ).toBe('agent_end')
        expect(admitted?.payload.interactivePrompt).toContain(`Request ${n}?`)
        await live.child.callHook(
          'tool_execution_end',
          { toolName: 'ask_user_question', toolCallId: `sdk-${n}` },
          live.ctx
        )
        await flush()
        expect(staleProbes).toBe(n)
        expect(visits).toBe(beforeOrdinary)
        expect(admitted?.payload).toMatchObject({
          state: 'done',
          prompt: 'Lead prompt',
          lastAssistantMessage: 'Lead answer'
        })
        expect(admitted?.payload.interactivePrompt).toBeUndefined()
        const a = await open(n + 1)
        const b = await open(n + 2)
        a.dispose()
        const beforeResidual = visits
        const beforeDead = staleProbes
        await h.callHook(
          'message_end',
          { message: { role: 'assistant', content: 'B remains live' } },
          root
        )
        await flush()
        expect(visits).toBe(beforeResidual)
        expect(staleProbes).toBe(beforeDead)
        expect(admitted?.payload.interactivePrompt).toContain(`Request ${n + 2}?`)
        await b.child.callHook('tool_execution_end', { toolName: 'ask_user_question' }, b.ctx)
        await flush()
        expect(staleProbes - beforeDead).toBe(1)
        expect(visits - beforeResidual).toBe(1)
        expect(admitted?.payload).toMatchObject({
          state: 'done',
          lastAssistantMessage: 'B remains live'
        })
        expect(admitted?.payload.interactivePrompt).toBeUndefined()
        const burst: Awaited<ReturnType<typeof open>>[] = []
        for (let i = 0; i < n; i++) {
          burst.push(await open(n + 3 + i))
        }
        for (const source of burst) {
          source.dispose()
        }
        const beforeBurst = visits
        const beforeBurstDead = staleProbes
        const survivor = await open(2 * n + 3)
        expect(staleProbes - beforeBurstDead).toBe(n)
        expect(visits - beforeBurst).toBe(n + 4)
        const afterBurst = visits
        await survivor.child.callHook(
          'tool_execution_end',
          { toolName: 'ask_user_question' },
          survivor.ctx
        )
        await flush()
        expect(visits).toBe(afterBurst)
        expect(staleProbes - beforeBurstDead).toBe(n)
        expect(admitted?.payload.state).toBe('done')
      }
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
