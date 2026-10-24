import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import {
  createHookListenerState,
  clearPaneCacheState
} from '../../shared/agent-hook-listener/listener-state'
import { cacheRelayLegacyAgentStatus } from '../../shared/agent-status-legacy-relay-cache'
import { buildOmpPlanReviewAnswer } from '../../shared/omp-plan-review-prompt'
import * as sessionDispatch from './agent-status-extension-test-context'
import {
  createAgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'

const context = (id: string, file?: string): HookContext => ({
  sessionManager: { getSessionId: () => id, getSessionFile: () => file },
  isIdle: () => true,
  ui: { setTitle: vi.fn() }
})
const receiverEnv = {
  ORCA_TAB_ID: 'source-lifetime',
  ORCA_PANE_KEY: makePaneKey('source-lifetime', '44444444-4444-4444-8444-444444444444'),
  ORCA_AGENT_HOOK_ENV: 'production',
  ORCA_AGENT_HOOK_VERSION: '1'
}
const flush = () => vi.advanceTimersByTimeAsync(0)
const payloads = (h: ReturnType<typeof createAgentStatusExtensionHarness>) =>
  h.fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).payload)

describe('selected source lifetime', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('hands fileless new/fork/resume/reload to the announced successor only', async () => {
    const h = createAgentStatusExtensionHarness({
      kind: 'pi',
      argv: ['node', '/usr/bin/pi'],
      existsSync: () => true
    })
    let active = { callHook: h.callHook }
    let ctx = context('fileless')
    await active.callHook('session_start', { reason: 'startup' }, ctx)
    await active.callHook('agent_start', {}, ctx)
    await flush()
    expect(payloads(h).at(-1)).not.toHaveProperty('session_file')
    const refused = async (reason: string, file?: string) => {
      await flush()
      const before = payloads(h).length
      const child = h.registerSession()
      await child.callHook('session_start', { reason }, context('unannounced', file))
      await child.callHook('agent_start', {}, context('unannounced', file))
      await flush()
      expect(payloads(h)).toHaveLength(before)
      expect(payloads(h).at(-1)?.session_id).not.toBe('unannounced')
    }
    // A cancelled operation never shuts the selected runner down.
    await refused('new')
    for (const [reason, id, file] of [
      ['new', 'new-fileless', undefined],
      ['fork', 'fork-fileless', undefined],
      ['resume', 'persisted', '/persisted.jsonl'],
      ['reload', 'persisted', '/persisted.jsonl']
    ] as const) {
      const old = active
      await old.callHook('session_shutdown', { reason, targetSessionFile: file }, ctx)
      if (reason !== 'reload') {
        await refused('startup')
        await refused(reason === 'new' ? 'fork' : 'new')
        await refused(reason, '/wrong-target.jsonl')
      }
      const next = context(id, file)
      active = h.registerSession()
      await active.callHook(
        'session_start',
        {
          reason,
          ...(reason === 'reload'
            ? {}
            : { previousSessionFile: ctx.sessionManager?.getSessionFile?.() })
        },
        next
      )
      const beforeStart = payloads(h).length
      await active.callHook('agent_start', {}, next)
      await flush()
      expect(payloads(h).length).toBeGreaterThan(beforeStart)
      expect(payloads(h).at(-1)?.hook_event_name).toBe('agent_start')
      await active.callHook('agent_end', {}, next)
      await flush()
      expect(payloads(h).at(-1)).toMatchObject({
        hook_event_name: 'agent_end',
        ...(file ? { session_id: id } : {})
      })
      if (!file) {
        expect(payloads(h).at(-1)).not.toHaveProperty('session_file')
      }
      const count = payloads(h).length
      await old.callHook('agent_start', {}, ctx)
      await flush()
      expect(payloads(h)).toHaveLength(count)
      await refused(reason)
      ctx = next
    }
  })

  it.each(['first', 'last', 'only', undefined] as const)(
    'shares selection with titlebar=%s without retiring the other producer',
    async (titlebar) => {
      const h = createAgentStatusExtensionHarness({
        kind: 'pi',
        argv: ['node', '/usr/bin/pi'],
        titlebar,
        existsSync: () => true
      })
      const root = context('lead', '/lead.jsonl')
      await h.callHook('session_start', { reason: 'startup' }, root)
      await h.callHook('agent_start', {}, root)
      const child = h.registerSession()
      await child.callHook('session_start', { reason: 'startup' }, context('helper'))
      await child.callHook('agent_start', {}, context('helper'))
      if (titlebar) {
        const before = vi.mocked(root.ui!.setTitle!).mock.calls.length
        await vi.advanceTimersByTimeAsync(160)
        expect(vi.mocked(root.ui!.setTitle!).mock.calls.length).toBeGreaterThan(before)
      }
      await h.callHook('ui_prompt_start', {}, root)
      await h.callHook('session_shutdown', { reason: 'new', targetSessionFile: undefined }, root)
      await flush()
      if (titlebar) {
        expect(vi.mocked(root.ui!.setTitle!).mock.lastCall?.[0]).toBe('π - selected title - repo')
      }
      if (titlebar !== 'only') {
        expect(payloads(h).at(-1)).toMatchObject({
          hook_event_name: 'agent_end',
          session_boundary: true
        })
      }
      const count = vi.mocked(root.ui!.setTitle!).mock.calls.length
      const next = h.registerSession()
      const nextCtx = context('new')
      await next.callHook(
        'session_start',
        { reason: 'new', previousSessionFile: '/lead.jsonl' },
        nextCtx
      )
      await next.callHook('agent_start', {}, nextCtx)
      await flush()
      if (titlebar !== 'only') {
        expect(payloads(h).at(-1)).toMatchObject({
          hook_event_name: 'agent_start'
        })
      }
      expect(payloads(h).at(-1)?.ui_prompt_active).not.toBe(true)
      await h.callHook('agent_start', {}, root)
      await vi.advanceTimersByTimeAsync(160)
      expect(vi.mocked(root.ui!.setTitle!).mock.calls.length).toBe(count)
      await next.callHook('session_shutdown', { reason: 'reload' }, nextCtx)
      const reloaded = h.registerSession()
      await reloaded.callHook('session_start', { reason: 'reload' }, nextCtx)
      await reloaded.callHook('agent_start', {}, nextCtx)
      await reloaded.callHook('agent_end', {}, nextCtx)
      await flush()
      if (titlebar) {
        expect(vi.mocked(nextCtx.ui!.setTitle!).mock.lastCall?.[0]).toBe(
          'π - selected title - repo'
        )
      }
    }
  )

  it.each(['first', 'last', 'only'] as const)(
    'moves OMP painter through switch with titlebar=%s',
    async (titlebar) => {
      const h = createAgentStatusExtensionHarness({ kind: 'omp', titlebar })
      const root = context('lead', '/lead.jsonl')
      await h.callHook('session_start', {}, root)
      await h.callHook('agent_start', {}, root)
      const next = context('fork', '/fork.jsonl')
      await h.callHook('session_branch', { reason: 'fork' }, next)
      await h.callHook('agent_start', {}, next)
      const before = vi.mocked(root.ui!.setTitle!).mock.calls.length
      await vi.advanceTimersByTimeAsync(160)
      expect(vi.mocked(root.ui!.setTitle!).mock.calls.length).toBe(before)
      await h.callHook('agent_end', {}, next)
      await flush()
      expect(vi.mocked(next.ui!.setTitle!).mock.lastCall?.[0]).toBe('π - selected title - repo')
    }
  )

  it.each(['pi', 'omp'] as const)(
    'keeps a pre-upgrade %s process reporting through helper-first reload',
    async (kind) => {
      const h = createAgentStatusExtensionHarness({
        kind,
        env: { ORCA_PI_STATUS_OWNED: '4242' },
        existsSync: () => true
      })
      const child = h.registerSession()
      await child.callHook(
        'session_start',
        { reason: 'startup' },
        context('helper', '/helper.jsonl')
      )
      await h.callHook('session_start', { reason: 'reload' }, context('lead', '/lead.jsonl'))
      await h.callHook('agent_start', {}, context('lead', '/lead.jsonl'))
      await flush()
      expect(payloads(h).at(-1)).toMatchObject({
        session_id: 'lead',
        hook_event_name: 'agent_start'
      })
    }
  )

  it.each(['pi', 'omp'] as const)(
    'retires only the originating %s attention and derives the lead close state',
    async (kind) => {
      const state = createHookListenerState()
      const normalized: NonNullable<ReturnType<typeof normalizeHookPayload>>[] = []
      const h = createAgentStatusExtensionHarness({
        kind,
        argv: ['node', kind],
        env: receiverEnv,
        existsSync: () => true,
        fetchImpl: async (_url, init) => {
          const event = normalizeHookPayload(
            state,
            kind,
            JSON.parse(String(init?.body)),
            'production'
          )
          if (event) {
            expect(
              cacheRelayLegacyAgentStatus(state, event, 16, (pane) =>
                clearPaneCacheState(state, pane)
              )
            ).toBe(true)
            normalized.push(event)
          }
          return { ok: true }
        }
      })
      const root = context('lead', '/lead.jsonl')
      await h.callHook('session_start', {}, root)
      await h.callHook('agent_start', {}, root)
      await h.callHook('agent_end', {}, root)
      await flush()
      expect(normalized.at(-1)?.payload.state).toBe('done')
      const child = h.registerSession()
      const childCtx = context('child')
      await child.callHook('session_start', {}, childCtx)
      for (const toolName of kind === 'pi'
        ? ['ask_user_question', 'request_user_input', 'AskUserQuestion']
        : ['ask']) {
        await child.callHook(
          'tool_call',
          {
            toolName,
            input: {
              questions: [
                {
                  id: 'choice',
                  question: 'Which output?',
                  options: [{ label: 'A' }, { label: 'B' }]
                }
              ]
            }
          },
          childCtx
        )
        await flush()
        expect(normalized.at(-1)?.payload.state).toBe('blocked')
        await child.callHook('tool_execution_start', { toolName }, childCtx)
        await child.callHook('tool_execution_end', { toolName }, childCtx)
        await flush()
        expect(normalized.at(-1)?.payload.state).toBe('done')
      }
      const questionTool = kind === 'pi' ? 'ask_user_question' : 'ask'
      const input = { questions: [{ question: 'Keep this request?', options: ['yes', 'no'] }] }
      await child.callHook('tool_call', { toolName: questionTool, input }, childCtx)
      await flush()
      await h.callHook('before_agent_start', { prompt: 'A real lead turn' }, root)
      await flush()
      expect(normalized.at(-1)).toMatchObject({
        hookEventName: 'before_agent_start',
        hasExplicitPrompt: true,
        providerSession: { id: 'lead' },
        payload: {
          state: 'blocked',
          prompt: 'A real lead turn',
          interactivePrompt: JSON.stringify(input)
        }
      })
      await h.callHook('agent_start', {}, root)
      await h.callHook(
        'tool_execution_start',
        { toolName: 'bash', input: { command: 'pwd' } },
        root
      )
      await flush()
      expect(normalized.at(-1)?.payload.toolName).toBe(questionTool)
      await h.callHook(
        'message_end',
        { message: { role: 'assistant', content: 'A real lead reply' } },
        root
      )
      await flush()
      expect(normalized.at(-1)?.payload).toMatchObject({
        state: 'blocked',
        prompt: 'A real lead turn',
        lastAssistantMessage: 'A real lead reply',
        interactivePrompt: JSON.stringify(input)
      })
      await h.callHook('agent_end', {}, root)
      await flush()
      expect(normalized.at(-1)?.payload.state).toBe('blocked')
      await h.callHook('before_agent_start', { prompt: 'Next lead turn' }, root)
      await h.callHook('agent_start', {}, root)
      await flush()
      expect(normalized.at(-1)?.payload.lastAssistantMessage).toBeUndefined()
      const ownerOpen = kind === 'pi' ? 'ui_prompt_start' : 'tool_approval_requested'
      const ownerClose = kind === 'pi' ? 'ui_prompt_end' : 'tool_approval_resolved'
      await h.callHook(ownerOpen, { toolName: 'bash', approvalMode: 'yolo' }, root)
      await h.callHook(ownerClose, { toolName: 'bash' }, root)
      await flush()
      expect(normalized.at(-1)?.payload).toMatchObject({
        state: 'blocked',
        interactivePrompt: JSON.stringify(input)
      })
      await child.callHook('tool_execution_end', { toolName: questionTool }, childCtx)
      await flush()
      expect(normalized.at(-1)?.payload.state).toBe('working')
      expect(normalized.at(-1)?.payload.interactivePrompt).toBeUndefined()
      expect(normalized.at(-1)?.payload.toolInput).toBeUndefined()
      await h.callHook('agent_start', {}, root)
      await child.callHook(
        'tool_call',
        { toolName: kind === 'pi' ? 'ask_user_question' : 'ask' },
        childCtx
      )
      await child.callHook(
        'tool_execution_end',
        { toolName: kind === 'pi' ? 'ask_user_question' : 'ask' },
        childCtx
      )
      await flush()
      expect(normalized.at(-1)?.payload.state).toBe('working')
      const open = kind === 'pi' ? 'ui_prompt_start' : 'tool_approval_requested'
      const close = kind === 'pi' ? 'ui_prompt_end' : 'tool_approval_resolved'
      await h.callHook(open, { toolName: 'lead-tool', approvalMode: 'yolo' }, root)
      await child.callHook(open, { toolName: 'child-tool', approvalMode: 'yolo' }, childCtx)
      await child.callHook(close, { toolName: 'child-tool', approvalMode: 'yolo' }, childCtx)
      await flush()
      expect(normalized.at(-1)?.payload.state).toBe(kind === 'pi' ? 'waiting' : 'blocked')
      await h.callHook(close, { toolName: 'lead-tool', approvalMode: 'yolo' }, root)
      const other = h.registerSession()
      const otherCtx = context('other')
      await other.callHook('session_start', {}, otherCtx)
      await child.callHook(open, { toolName: 'bash', approvalMode: 'yolo' }, childCtx)
      await other.callHook(open, { toolName: 'read', approvalMode: 'yolo' }, otherCtx)
      await child.callHook('session_shutdown', {}, childCtx)
      await flush()
      expect(normalized.at(-1)?.payload.state).toBe(kind === 'pi' ? 'waiting' : 'blocked')
      await h.callHook('agent_end', {}, root)
      await other.callHook('session_shutdown', {}, otherCtx)
      await flush()
      expect(normalized.at(-1)?.payload.state).toBe('done')
      await h.callHook('agent_start', {}, root)
      await h.callHook(open, { toolName: 'lead-tool', approvalMode: 'yolo' }, root)
      // A new turn also retires an abandoned wait on that same source.
      await h.callHook('agent_start', {}, root)
      const fresh = h.registerSession()
      const freshCtx = context('fresh')
      await fresh.callHook('session_start', {}, freshCtx)
      await fresh.callHook(open, { toolName: 'fresh-tool', approvalMode: 'yolo' }, freshCtx)
      await fresh.callHook(close, { toolName: 'fresh-tool', approvalMode: 'yolo' }, freshCtx)
      await flush()
      expect(normalized.at(-1)?.payload.state).toBe('working')
      expect(payloads(h).every((payload) => payload.session_id === 'lead')).toBe(true)
    }
  )

  it('bounds mutation and activation work by stored sources with zero live ordinary replay', async () => {
    const measure = async (n: number) => {
      let visits = 0
      let sourceVisits = 0
      let recordVisits = 0
      const originalCountingMap = sessionDispatch.createCountingMap
      const count = vi.spyOn(sessionDispatch, 'createCountingMap').mockImplementation((onEntry) => {
        const Base = originalCountingMap(onEntry)
        return class<K, V> extends Base<K, V> {
          *values(): MapIterator<V> {
            for (const value of super.values()) {
              recordVisits++
              yield value
            }
          }
          *[Symbol.iterator](): MapIterator<[K, V]> {
            for (const entry of super[Symbol.iterator]()) {
              sourceVisits++
              yield entry
            }
          }
        }
      })
      const state = createHookListenerState()
      let admitted: ReturnType<typeof normalizeHookPayload> | undefined
      const h = createAgentStatusExtensionHarness({
        kind: 'omp',
        env: receiverEnv,
        onMapEntry: () => visits++,
        fetchImpl: async (_url, init) => {
          admitted = normalizeHookPayload(
            state,
            'omp',
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
      count.mockRestore()
      const sources: { child: ReturnType<typeof h.registerSession>; ctx: HookContext }[] = []
      let opens = 0
      for (let i = 0; i < n; i++) {
        const child = h.registerSession()
        const ctx = { ...context(String(i)), agent: { kind: 'sub' as const } }
        await child.callHook('session_start', {}, ctx)
        for (const name of ['tool_call', 'tool_execution_start']) {
          const beforeSources = sourceVisits
          const beforeRecords = recordVisits
          await child.callHook(
            name,
            {
              toolName: 'ask',
              toolCallId: `call-${i}`,
              [name === 'tool_call' ? 'input' : 'args']: { question: 'Choose?' }
            },
            ctx
          )
          opens++
          expect(sourceVisits - beforeSources).toBe(i + 1)
          expect(recordVisits - beforeRecords).toBe(i + 1)
        }
        sources.push({ child, ctx })
      }
      expect(opens).toBe(2 * n)
      expect(sourceVisits).toBe(n * (n + 1))
      expect(recordVisits).toBe(sourceVisits)
      const replacement = sources.at(-1)!
      const replacements = 5
      const beforeReplacement = visits
      for (let i = 0; i < replacements; i++) {
        await replacement.child.callHook(
          'tool_execution_start',
          { toolName: 'ask', toolCallId: `replace-${i}` },
          replacement.ctx
        )
      }
      expect(visits - beforeReplacement).toBe(2 * n * replacements)
      expect(visits).toBe(sourceVisits + recordVisits)
      const abandoned = sources.pop()!
      let before = visits
      await abandoned.child.callHook('session_shutdown', {}, abandoned.ctx)
      expect(visits - before).toBeLessThanOrEqual(4)
      const root = { ...context('lead'), agent: { kind: 'main' as const } }
      before = visits
      await h.callHook('session_start', {}, root)
      const drain = visits - before
      expect(drain).toBeGreaterThanOrEqual(n - 1)
      expect(drain).toBeLessThanOrEqual(4 * n)
      await flush()
      before = visits
      for (let i = 0; i < 10; i++) {
        await h.callHook('agent_start', {}, root)
      }
      await flush()
      expect(visits - before).toBe(0)
      expect(payloads(h).at(-1)?.hook_event_name).toBe('agent_start')
      expect(admitted?.payload).toMatchObject({ state: 'blocked', toolName: 'ask' })
      before = visits
      for (const { child, ctx } of sources) {
        const start = visits
        await child.callHook('session_shutdown', {}, ctx)
        expect(visits - start).toBeLessThanOrEqual(4 * n)
      }
      expect(visits - before).toBeLessThanOrEqual(4 * n * n)
      await flush()
      expect(admitted?.payload.state).toBe('working')
      before = visits
      await h.callHook('agent_start', {}, root)
      await flush()
      expect(visits - before).toBe(0)
      expect(admitted?.payload.state).toBe('working')
      expect(payloads(h).at(-1)).not.toHaveProperty('approval_mode')
      return drain
    }
    expect(await measure(100)).toBeLessThanOrEqual(10 * (await measure(10)) + 20)
  })

  it('clears coalesced approval/plan closes through admitted metadata and keeps source-local answers', async () => {
    const state = createHookListenerState()
    let row: ReturnType<typeof normalizeHookPayload> | undefined
    let release: (() => void) | undefined
    let hold = false
    const h = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: receiverEnv,
      fetchImpl: async (_url, init) => {
        row = normalizeHookPayload(state, 'omp', JSON.parse(String(init?.body)), 'production')
        if (row) {
          expect(
            cacheRelayLegacyAgentStatus(state, row, 16, (pane) => clearPaneCacheState(state, pane))
          ).toBe(true)
        }
        if (hold) {
          hold = false
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return { ok: true }
      }
    })
    const root = context('lead')
    await h.callHook('session_start', {}, root)
    await h.callHook('before_agent_start', { prompt: 'Lead prompt' }, root)
    await h.callHook(
      'message_end',
      { message: { role: 'assistant', content: 'Lead preview' } },
      root
    )
    await flush()
    await h.callHook('agent_end', {}, root)
    await flush()
    const child = h.registerSession()
    const childCtx = context('child')
    await child.callHook('session_start', {}, childCtx)
    hold = true
    await child.callHook(
      'tool_approval_requested',
      { toolName: 'bash', reason: 'Confirm deletion', approvalMode: 'yolo' },
      childCtx
    )
    await flush()
    expect(row?.payload).toMatchObject({ state: 'blocked', toolInput: 'Confirm deletion' })
    await child.callHook('tool_approval_resolved', { toolName: 'bash', approved: true }, childCtx)
    await h.callHook('model_select', { model: { provider: 'test', id: 'next' } }, root)
    release?.()
    await flush()
    expect(payloads(h).at(-1)?.hook_event_name).toBe('model_select')
    expect(row?.payload).toMatchObject({
      state: 'done',
      prompt: 'Lead prompt',
      lastAssistantMessage: 'Lead preview',
      model: 'test/next'
    })
    expect(row?.payload.toolInput).toBeUndefined()
    let listener: ((data: string) => { consume?: boolean } | undefined) | undefined
    const resolvePlanReview = vi.fn(() => true)
    childCtx.resolvePlanReview = resolvePlanReview
    childCtx.ui = {
      onTerminalInput: (handler) => {
        listener = handler
        return () => {
          listener = undefined
        }
      }
    }
    await child.callHook(
      'plan_review_requested',
      {
        reviewId: 'review',
        planContent: '# A real plan',
        options: [{ id: 'execute', label: 'Execute' }]
      },
      childCtx
    )
    await flush()
    expect(row?.payload.state).toBe('blocked')
    expect(listener?.(buildOmpPlanReviewAnswer('review', 'execute'))).toEqual({ consume: true })
    expect(resolvePlanReview).toHaveBeenCalledWith('review', 'execute')
    hold = true
    await h.callHook('model_select', { model: { provider: 'test', id: 'final' } }, root)
    await child.callHook(
      'plan_review_resolved',
      { reviewId: 'review', choice: 'execute' },
      childCtx
    )
    h.emitPiEvent('task:subagent:lifecycle', { id: 'finished', status: 'completed' })
    release?.()
    await flush()
    expect(listener).toBeUndefined()
    expect(row?.payload.state).toBe('done')
    expect(row?.payload.interactivePrompt).toBeUndefined()
    expect(row?.payload.toolInput).toBeUndefined()
    await child.callHook(
      'plan_review_requested',
      { reviewId: 'abandoned', planContent: '# Pending', options: [] },
      childCtx
    )
    await child.callHook('agent_start', {}, childCtx)
    expect(listener).toBeUndefined()
    await h.callHook('agent_start', {}, root)
    h.emitPiEvent('task:subagent:lifecycle', { id: 'running', status: 'started' })
    root.resolvePlanReview = resolvePlanReview
    root.ui = childCtx.ui
    await h.callHook(
      'plan_review_requested',
      { reviewId: 'owner', planContent: '# Owner plan', options: [] },
      root
    )
    await h.callHook('agent_end', {}, root)
    await h.callHook('plan_review_resolved', { reviewId: 'owner' }, root)
    await flush()
    expect(row?.payload.state).toBe('working')
    expect(row?.payload.interactivePrompt).toBeUndefined()
    h.emitPiEvent('task:subagent:lifecycle', { id: 'running', status: 'completed' })
    await flush()
    expect(row?.payload.state).toBe('done')
  })

  it('retires disposed Pi modal sources once and reveals a live idle question without shutdown', async () => {
    let visits = 0
    const h = createAgentStatusExtensionHarness({
      kind: 'pi',
      argv: ['node', '/usr/bin/pi'],
      onMapEntry: () => visits++
    })
    const root = context('lead')
    await h.callHook('session_start', {}, root)
    await h.callHook('agent_start', {}, root)
    const child = h.registerSession()
    let disposed = false
    let probes = 0
    const manager = context('disposed').sessionManager
    const stale: HookContext = {
      isIdle: () => true,
      get sessionManager() {
        probes++
        if (disposed) {
          throw new Error('Extension context is no longer active')
        }
        return manager
      }
    }
    await child.callHook('session_start', {}, stale)
    await child.callHook('ui_prompt_start', {}, stale)
    const live = h.registerSession()
    const liveCtx = context('idle-live')
    await live.callHook('session_start', {}, liveCtx)
    await live.callHook(
      'tool_call',
      { toolName: 'request_user_input', input: { questions: [{ question: 'Still alive?' }] } },
      liveCtx
    )
    await flush()
    expect(payloads(h).at(-1)?.ui_prompt_active).toBe(true)
    disposed = true
    const before = visits
    probes = 0
    await h.callHook('message_end', { message: { role: 'assistant', content: 'Lead text' } }, root)
    await flush()
    expect(visits - before).toBeLessThanOrEqual(8)
    expect(probes).toBe(1)
    expect(payloads(h).at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Lead text',
      tool_name: 'request_user_input'
    })
    expect(payloads(h).at(-1)?.ui_prompt_active).not.toBe(true)
    const after = visits
    await h.callHook('message_end', { message: { role: 'assistant', content: 'More text' } }, root)
    await flush()
    expect(visits).toBe(after)
    await live.callHook('agent_start', {}, liveCtx)
    await flush()
    expect(payloads(h).at(-1)).not.toHaveProperty('tool_input')
    await live.callHook('session_shutdown', {}, liveCtx)
    await h.callHook('agent_start', {}, root)
    await flush()
    expect(payloads(h).at(-1)?.ui_prompt_active).not.toBe(true)
  })

  it('removes retired owner presentation before a declared OMP successor first publishes', async () => {
    const h = createAgentStatusExtensionHarness({ kind: 'pi', title: 'omp' })
    const old: HookContext = { ...context('old', '/old.jsonl'), agent: { kind: 'main' } }
    await h.callHook('session_start', {}, old)
    const child = h.registerSession()
    const childCtx: HookContext = { ...context('child'), agent: { kind: 'sub' } }
    await child.callHook('session_start', {}, childCtx)
    await child.callHook(
      'tool_call',
      { toolName: 'ask', input: { question: 'Still live?' } },
      childCtx
    )
    await h.callHook(
      'tool_approval_requested',
      { toolName: 'bash', approvalMode: 'yolo', reason: 'Retired owner' },
      old
    )
    await flush()
    await h.callHook('session_shutdown', { reason: 'new' }, old)
    // OMP contexts hold a plain manager reference that remains readable after shutdown.
    expect(old.sessionManager?.getSessionId?.()).toBe('old')
    const next = h.registerSession()
    const nextCtx: HookContext = { ...context('next', '/next.jsonl'), agent: { kind: 'main' } }
    await next.callHook('session_start', {}, nextCtx)
    await flush()
    const successor = payloads(h).filter((payload) => payload.session_id === 'next')
    expect(successor.length).toBeGreaterThan(0)
    for (const payload of successor) {
      expect(payload).toMatchObject({ tool_name: 'ask', tool_input: { question: 'Still live?' } })
      expect(payload).not.toHaveProperty('approval_mode')
    }
  })

  it('keeps Prime always active through shutdown and re-registration', async () => {
    const h = createAgentStatusExtensionHarness({ kind: 'prime-agent', existsSync: () => true })
    await h.callHook('session_start', {}, context('lead'))
    await h.callHook('session_shutdown', {}, context('lead'))
    h.reload()
    await h.callHook('session_start', {}, context('next', '/next.jsonl'))
    await h.callHook('agent_start', {}, context('next', '/next.jsonl'))
    await flush()
    expect(payloads(h).at(-1)).toMatchObject({ session_id: 'next', hook_event_name: 'agent_start' })
  })
})
