import { describe, expect, it, vi } from 'vitest'
import {
  createAgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { AgentHookServer } from '../agent-hooks/server'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

class StatusSink extends AgentHookServer {
  accept(body: unknown, source: 'pi' | 'omp') {
    const event = normalizeHookPayload(this.state, source, body, 'production')
    return event ? this.applyNormalizedStatus(event) : undefined
  }
  savedRow() {
    return JSON.parse(this.serializeStatusFile()).entries[paneKey]
  }
}

const paneKey = makePaneKey('declared-session', '44444444-4444-4444-8444-444444444444')
function session(id: string, kind: 'main' | 'sub'): HookContext {
  return {
    agent: { kind },
    hasUI: false,
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => `/sessions/${id}.jsonl`,
      getHeader: () => (kind === 'main' ? { parentSession: '/sessions/ancestor.jsonl' } : {})
    }
  }
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve()
  }
}

describe('declared session authority', () => {
  it('keeps the selected transcript at the listener and restart identity sink', async () => {
    const sink = new StatusSink()
    const accepted: ReturnType<typeof normalizeHookPayload>[] = []
    const harness = createAgentStatusExtensionHarness({
      kind: 'pi',
      argv: ['bun', '/opt/omp/bin/omp'],
      existsSync: () => true,
      env: {
        ORCA_PANE_KEY: paneKey,
        ORCA_AGENT_HOOK_ENV: 'production',
        ORCA_AGENT_HOOK_VERSION: '1',
        ORCA_TAB_ID: 'declared-session'
      },
      fetchImpl: async (_url, init) => {
        const event = sink.accept(JSON.parse(String(init?.body)), 'omp')
        if (event) {
          accepted.push(event)
        }
        return { ok: true }
      }
    })
    const helper = harness.registerSession()
    const child = session('helper', 'sub')
    await helper.callHook('session_start', {}, child)
    await helper.callHook('agent_start', {}, child)
    const root = session('lead', 'main')
    await harness.callHook('session_start', {}, root)
    await settle()
    expect(accepted).toEqual([])
    await harness.callHook('before_agent_start', { prompt: 'lead work' }, root)
    await settle()
    await harness.callHook('agent_end', {}, root)
    await helper.callHook(
      'message_end',
      { message: { role: 'assistant', content: 'helper reply' } },
      child
    )
    await helper.callHook('agent_end', {}, child)
    await settle()
    expect(accepted.at(-1)).toMatchObject({
      providerSession: { id: 'lead' },
      payload: { state: 'done', prompt: 'lead work' }
    })
    expect(accepted.every((event) => event?.providerSession?.id === 'lead')).toBe(true)
    const saved = sink.savedRow()?.providerSession
    expect(saved).toMatchObject({ id: 'lead', transcriptPath: '/sessions/lead.jsonl' })
  })

  it('relays early child attention without sharing model, prompt, roster or callbacks', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const helper = harness.registerSession()
    const child = session('helper', 'sub')
    const stopInput = vi.fn()
    child.model = { provider: 'child', id: 'model' }
    child.resolvePlanReview = vi.fn(() => true)
    child.ui = { onTerminalInput: vi.fn(() => stopInput) }
    await helper.callHook(
      'tool_approval_requested',
      { toolName: 'bash', approvalMode: 'yolo' },
      child
    )
    await helper.callHook(
      'plan_review_requested',
      { reviewId: 'review', planContent: 'plan', options: [] },
      child
    )
    const abandoned = harness.registerSession()
    const stopAbandoned = vi.fn()
    const abortedContext = { ...child, ui: { onTerminalInput: () => stopAbandoned } }
    await abandoned.callHook(
      'plan_review_requested',
      { reviewId: 'abandoned', options: [] },
      abortedContext
    )
    await abandoned.callHook('session_shutdown', {}, abortedContext)
    expect(stopAbandoned).toHaveBeenCalledOnce()
    await helper.callHook('session_start', {}, child)
    expect(harness.fetchMock).not.toHaveBeenCalled()
    const root = session('lead', 'main')
    root.model = { provider: 'lead', id: 'model' }
    await harness.callHook('session_start', {}, root)
    await vi.waitFor(() => expect(harness.fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1))
    const payloads = (): Record<string, unknown>[] =>
      harness.fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).payload)
    expect(
      payloads().every((payload) => payload.session_id === 'lead' && payload.model === 'lead/model')
    ).toBe(true)
    expect(payloads().at(-1)).toMatchObject({
      hook_event_name: 'plan_review_requested',
      review_id: 'review'
    })
    expect(payloads().some((payload) => payload.review_id === 'abandoned')).toBe(false)
    await helper.callHook('plan_review_resolved', { reviewId: 'review' }, child)
    expect(stopInput).toHaveBeenCalledOnce()
    await vi.waitFor(() =>
      expect(payloads().at(-1)).toMatchObject({
        hook_event_name: 'tool_approval_requested',
        tool_name: 'bash'
      })
    )
    await helper.callHook('tool_call', { toolName: 'ask', input: { question: 'choose' } }, child)
    await vi.waitFor(() => expect(payloads().at(-1)?.tool_name).toBe('ask'))
    // Advisor tools have a sub identity on the selected session's own runner.
    await harness.callHook(
      'tool_execution_end',
      { toolName: 'ask' },
      { ...root, agent: { kind: 'sub' } }
    )
    await harness.callHook('before_agent_start', { prompt: 'lead prompt' }, root)
    await harness.callHook('agent_start', {}, root)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'task', status: 'started' })
    const laterHelper = harness.registerSession()
    const fileless = session('later-helper', 'sub')
    if (fileless.sessionManager) {
      fileless.sessionManager.getSessionFile = () => undefined
    }
    await laterHelper.callHook('session_start', {}, fileless)
    await harness.callHook('agent_end', {}, root)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'task', status: 'completed' })
    await vi.waitFor(() => expect(payloads().at(-1)?.hook_event_name).toBe('agent_end'))
    expect(payloads().every((payload) => payload.session_id === 'lead')).toBe(true)
    const previous = { ...harness.handlers }
    harness.reload()
    await harness.callHook('session_start', { reason: 'reload' }, root)
    await harness.callHook('agent_start', {}, root)
    await vi.waitFor(() => expect(payloads().at(-1)?.hook_event_name).toBe('agent_start'))
    const count = harness.fetchMock.mock.calls.length
    await previous.before_agent_start({ prompt: 'stale' }, root)
    await previous.model_select({ model: { provider: 'stale', id: 'model' } }, root)
    await previous.session_shutdown({}, root)
    await settle()
    expect(harness.fetchMock).toHaveBeenCalledTimes(count)
    await harness.callHook('agent_end', {}, root)
    await vi.waitFor(() =>
      expect(payloads().at(-1)).toMatchObject({ hook_event_name: 'agent_end', model: 'lead/model' })
    )
  })

  it.each(['pi', 'omp'] as const)(
    'keeps a tool-spawned helper off the %s pane and restart identity',
    async (kind) => {
      const sink = new StatusSink()
      const accepted: ReturnType<typeof normalizeHookPayload>[] = []
      const harness = createAgentStatusExtensionHarness({
        kind,
        argv: kind === 'pi' ? ['node', '/usr/bin/pi'] : ['bun', '/opt/omp/bin/omp'],
        existsSync: () => true,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'declared-session',
          ORCA_AGENT_HOOK_ENV: 'production',
          ORCA_AGENT_HOOK_VERSION: '1'
        },
        fetchImpl: async (_url, init) => {
          accepted.push(sink.accept(JSON.parse(String(init?.body)), kind) ?? null)
          return { ok: true }
        }
      })
      const root = session('lead', 'main')
      delete root.agent
      const child = session('helper', 'sub')
      delete child.agent
      await harness.callHook('session_start', { reason: 'startup' }, root)
      await harness.callHook('before_agent_start', { prompt: 'lead work' }, root)
      await harness.callHook('agent_start', {}, root)
      await harness.callHook('tool_execution_start', { toolName: 'task' }, root)
      // The task constructs its own runtime while the lead turn is in progress.
      const helper = harness.registerSession()
      await helper.callHook('session_start', { reason: 'startup' }, child)
      await helper.callHook('before_agent_start', { prompt: 'helper work' }, child)
      await helper.callHook('agent_start', {}, child)
      await settle()
      expect(accepted.every((event) => event?.providerSession?.id === 'lead')).toBe(true)
      await harness.callHook('agent_end', {}, root)
      await helper.callHook(
        'message_end',
        { message: { role: 'assistant', content: 'helper reply' } },
        child
      )
      await helper.callHook('agent_end', {}, child)
      await helper.callHook('session_shutdown', {}, child)
      await vi.waitFor(() => expect(accepted.at(-1)?.payload.state).toBe('done'))
      expect(accepted.at(-1)).toMatchObject({
        providerSession: { id: 'lead' },
        payload: kind === 'omp' ? { prompt: 'lead work' } : {}
      })
      expect(sink.savedRow()?.providerSession).toMatchObject({
        id: 'lead',
        transcriptPath: '/sessions/lead.jsonl'
      })
      let current = root
      for (const reason of ['new', 'resume', 'fork', 'reload'] as const) {
        const next =
          reason === 'reload' ? current : session(reason === 'resume' ? 'helper' : reason, 'main')
        delete next.agent
        const previousSessionFile = current.sessionManager?.getSessionFile?.()
        if (kind === 'pi') {
          const old = { ...harness.handlers }
          await (reason === 'reload'
            ? harness.reloadPi()
            : harness.replacePiSession(reason, String(next.sessionManager?.getSessionFile?.())))
          await harness.callHook(
            'session_start',
            { reason, ...(reason === 'reload' ? {} : { previousSessionFile }) },
            next
          )
          const count = accepted.length
          await old.before_agent_start({ prompt: 'stale' }, current)
          await settle()
          expect(accepted).toHaveLength(count)
        } else {
          await harness.callHook(
            reason === 'fork' ? 'session_branch' : 'session_switch',
            { reason },
            next
          )
        }
        await harness.callHook('before_agent_start', { prompt: reason }, next)
        await settle()
        await vi.waitFor(() =>
          expect(accepted.at(-1)?.providerSession?.id).toBe(next.sessionManager?.getSessionId?.())
        )
        current = next
      }
      if (child.sessionManager) {
        child.sessionManager.getHeader = () => ({ parentSession: '/sessions/lead.jsonl' })
      }
      // A fresh process can select a former helper, regardless of its saved parent header.
      const restarted = createAgentStatusExtensionHarness({ kind, existsSync: () => true })
      await restarted.callHook('session_start', { reason: 'startup' }, child)
      await restarted.callHook('agent_start', {}, child)
      await vi.waitFor(() =>
        expect(
          JSON.parse(String(restarted.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload.session_id
        ).toBe('helper')
      )
    }
  )
})
