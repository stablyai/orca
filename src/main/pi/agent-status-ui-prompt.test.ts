import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { PANE_KEY } from '../../shared/agent-hook-listener-test-harness'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

const HOOK_ENV = { ORCA_PANE_KEY: PANE_KEY, ORCA_AGENT_HOOK_ENV: 'production' }

function createHarness() {
  const state = createHookListenerState()
  const statuses: ReturnType<typeof normalizeHookPayload>[] = []
  const harness = createAgentStatusExtensionHarness({
    kind: 'pi',
    env: HOOK_ENV,
    fetchImpl: async (_url, init) => {
      statuses.push(normalizeHookPayload(state, 'pi', JSON.parse(String(init?.body)), 'production'))
      return { ok: true }
    }
  })
  return { ...harness, statuses }
}

async function flushPosts(): Promise<void> {
  // Each delivery has a bounded promise chain; no wall-clock sleeps in the harness.
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

async function post(harness: ReturnType<typeof createHarness>, name: string, event = {}) {
  await harness.callHook(name, event)
  await flushPosts()
}

describe('Pi UI prompt status', () => {
  it.each(['select', 'confirm', 'input', 'editor', 'custom'])(
    'blocks for %s without exposing modal contents and resumes work on close',
    async (kind) => {
      const harness = createHarness()
      await post(harness, 'agent_start')
      await post(harness, 'ui_prompt_start', { kind, title: 'Private title' })
      expect(harness.statuses.at(-1)?.payload.state).toBe('waiting')
      const body = JSON.parse(String(harness.fetchMock.mock.calls.at(-1)?.[1]?.body))
      expect(body.payload).toEqual({ hook_event_name: 'ui_prompt_start', ui_prompt_active: true })

      await harness.callHook('ui_prompt_end', { kind }, { isIdle: () => false })
      await flushPosts()
      expect(harness.statuses.at(-1)?.payload.state).toBe('working')
    }
  )

  it.each([
    'tool_call',
    'tool_execution_start',
    'tool_execution_end',
    'message_end',
    'agent_settled'
  ])('%s cannot clear an open modal', async (name) => {
    const harness = createHarness()
    await post(harness, 'ui_prompt_start')
    await post(harness, name, {
      toolName: 'ask_user_question',
      input: { questions: [{ question: 'Stale question' }] },
      message: { role: 'assistant', content: [{ type: 'text', text: 'Still here' }] }
    })
    expect(harness.statuses.at(-1)?.payload).toMatchObject({ state: 'waiting', agentType: 'pi' })
    expect(harness.statuses.at(-1)?.payload.toolName).toBeUndefined()
    expect(harness.statuses.at(-1)?.payload.interactivePrompt).toBeUndefined()
    await harness.callHook('ui_prompt_end', {}, { isIdle: () => true })
    await flushPosts()
    expect(harness.statuses.at(-1)?.payload.state).toBe('done')
  })

  it('clears stale question cards when a generic modal opens', async () => {
    const harness = createHarness()
    await post(harness, 'tool_call', {
      toolName: 'ask_user_question',
      input: { questions: [{ question: 'Pick one' }] }
    })
    expect(harness.statuses.at(-1)?.payload.interactivePrompt).toBeDefined()
    await post(harness, 'ui_prompt_start')
    expect(harness.statuses.at(-1)?.payload.toolName).toBeUndefined()
    expect(harness.statuses.at(-1)?.payload.toolInput).toBeUndefined()
    expect(harness.statuses.at(-1)?.payload.interactivePrompt).toBeUndefined()
  })

  it('returns an idle session to done after its modal closes', async () => {
    const harness = createHarness()
    await post(harness, 'ui_prompt_start')
    await harness.callHook('ui_prompt_end', {}, { isIdle: () => true })
    await flushPosts()
    expect(harness.statuses.map((status) => status?.payload.state)).toEqual(['waiting', 'done'])
  })

  it('does not infer done when the context cannot establish idleness', async () => {
    const harness = createHarness()
    await post(harness, 'ui_prompt_start')
    await post(harness, 'ui_prompt_end')
    expect(harness.statuses.at(-1)?.payload.state).toBe('working')
  })

  it('lets the normal settlement hook finish work after a modal closes', async () => {
    const harness = createHarness()
    await post(harness, 'agent_start')
    await post(harness, 'ui_prompt_start')
    await harness.callHook('ui_prompt_end', {}, { isIdle: () => false })
    await flushPosts()
    await post(harness, 'agent_settled')
    expect(harness.statuses.map((status) => status?.payload.state)).toEqual([
      'working',
      'waiting',
      'working',
      'done'
    ])
  })

  it('retains modal state across an in-process registration reload', async () => {
    const harness = createHarness()
    await post(harness, 'ui_prompt_start')
    harness.reload()
    await post(harness, 'session_start', { reason: 'reload' })
    await post(harness, 'tool_execution_end', { toolName: 'bash' })
    expect(harness.statuses.at(-1)?.payload.state).toBe('waiting')
  })

  it('keeps a session-switching modal blocked until it actually closes', async () => {
    const harness = createHarness()
    await post(harness, 'before_agent_start', { prompt: 'Old session prompt' })
    await post(harness, 'ui_prompt_start')
    await post(harness, 'session_start', { reason: 'switch' })
    expect(harness.statuses.at(-1)?.payload.state).toBe('waiting')
    expect(harness.statuses.at(-1)?.payload.prompt).toBe('')
    await harness.callHook('ui_prompt_end', {}, { isIdle: () => true })
    await flushPosts()
    expect(harness.statuses.at(-1)?.payload.state).toBe('done')
  })

  it('ignores an unmatched prompt end', async () => {
    const harness = createHarness()
    await post(harness, 'ui_prompt_end')
    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

  it('isolates prompt state between Pi processes', async () => {
    const first = createHarness()
    const second = createHarness()
    await post(first, 'ui_prompt_start')
    await post(second, 'agent_start')
    expect(first.statuses.at(-1)?.payload.state).toBe('waiting')
    expect(second.statuses.at(-1)?.payload.state).toBe('working')
  })

  it('preserves blocked when a stalled sender coalesces away the start event', async () => {
    let finish: (() => void) | undefined
    const harness = createAgentStatusExtensionHarness({
      kind: 'pi',
      env: HOOK_ENV,
      fetchImpl: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    })
    await harness.callHook('agent_start')
    await harness.callHook('ui_prompt_start')
    await harness.callHook('tool_execution_end', { toolName: 'bash' })
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    finish?.()
    await flushPosts()
    const state = createHookListenerState()
    const latest = JSON.parse(String(harness.fetchMock.mock.calls.at(-1)?.[1]?.body))
    expect(latest.payload.hook_event_name).toBe('tool_execution_end')
    expect(normalizeHookPayload(state, 'pi', latest, 'production')?.payload.state).toBe('waiting')

    await harness.callHook('ui_prompt_end', {}, { isIdle: () => false })
    await harness.callHook('tool_execution_start', { toolName: 'bash', args: { command: 'pwd' } })
    finish?.()
    await flushPosts()
    const resumed = JSON.parse(String(harness.fetchMock.mock.calls.at(-1)?.[1]?.body))
    expect(normalizeHookPayload(state, 'pi', resumed, 'production')?.payload.state).toBe('working')
    finish?.()
    await flushPosts()
  })

  it.each([
    { kind: 'omp' as const },
    { kind: 'prime-agent' as const },
    { kind: 'pi' as const, title: 'omp' }
  ])('does not add Pi prompt status to $kind ($title)', async (args) => {
    const harness = createAgentStatusExtensionHarness(args)
    await harness.callHook('ui_prompt_start')
    await harness.callHook('ui_prompt_end', {}, { isIdle: () => true })
    expect(harness.fetchMock).not.toHaveBeenCalled()
    await harness.callHook('tool_call', { toolName: 'bash', input: { command: 'pwd' } })
    const body = JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.payload.ui_prompt_active).toBeUndefined()
  })
})
