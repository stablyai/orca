import { describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests
} from '../../shared/agent-hook-listener/listener-state'
import { PANE_KEY } from '../../shared/agent-hook-listener-test-harness'
import type { AgentStatusPayload } from '../../shared/agent-status-types'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

function createStatusScenario(kind: 'pi' | 'omp' = 'omp') {
  const state = createHookListenerState()
  const rows: AgentStatusPayload[] = []
  const harness = createAgentStatusExtensionHarness({
    kind,
    title: 'omp',
    env: {
      ORCA_PANE_KEY: PANE_KEY,
      ORCA_AGENT_HOOK_ENV: 'production',
      ORCA_AGENT_HOOK_VERSION: '1'
    },
    fetchImpl: async (_url, init) => {
      const row = normalizeHookPayload(state, 'omp', JSON.parse(String(init?.body)), 'production')
      if (row) {
        seedLegacyAgentStatusForTests(state, row)
        rows.push(row.payload)
      }
      return { ok: true }
    }
  })
  return { harness, rows }
}

const idle = {
  isIdle: () => true,
  hasPendingMessages: () => false,
  getAsyncJobSnapshot: () => ({ running: [] })
}

describe('managed OMP status transitions', () => {
  it.each(['pi', 'omp'] as const)(
    'reports readiness and clears turn details on %s session switch',
    async (kind) => {
      const { harness, rows } = createStatusScenario(kind)
      await harness.callHook('session_start', {}, idle)
      await vi.waitFor(() =>
        expect(rows.at(-1)).toMatchObject({ state: 'done', sessionBoundary: true })
      )
      await harness.callHook('before_agent_start', { prompt: 'old request' }, idle)
      await harness.callHook(
        'tool_execution_start',
        { toolName: 'bash', args: { command: 'pwd' } },
        idle
      )
      await vi.waitFor(() => expect(rows.at(-1)?.toolName).toBe('bash'))
      await harness.callHook('session_switch', {}, idle)
      await vi.waitFor(() =>
        expect(rows.at(-1)).toMatchObject({ state: 'done', sessionBoundary: true })
      )
      expect(rows.at(-1)?.prompt || undefined).toBeUndefined()
      expect(rows.at(-1)?.toolName).toBeUndefined()
      expect(rows.at(-1)?.mainAgent).toBeUndefined()
    }
  )

  it('does not infer readiness from an incomplete startup snapshot', async () => {
    const { harness, rows } = createStatusScenario()
    await harness.callHook('session_start', {}, { isIdle: () => true })
    await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('working'))
  })

  it('keeps readiness unknown when the async snapshot is null', async () => {
    const { harness, rows } = createStatusScenario()
    await harness.callHook('session_start', {}, { ...idle, getAsyncJobSnapshot: () => null })
    await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('working'))
  })

  it.each(['auto_retry', 'auto_compaction'])(
    'restores readiness after %s without a completed turn',
    async (phase) => {
      const { harness, rows } = createStatusScenario()
      await harness.callHook(`${phase}_start`, {}, idle)
      await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('working'))
      await harness.callHook(`${phase}_end`, {}, idle)
      await vi.waitFor(() =>
        expect(rows.at(-1)).toMatchObject({ state: 'done', sessionBoundary: true })
      )
      expect(rows.at(-1)?.mainAgent).toBeUndefined()
    }
  )

  it.each([false, true])('keeps pending messages active with settled event %s', async (settled) => {
    const { harness, rows } = createStatusScenario()
    let pending = true
    const context = { ...idle, hasPendingMessages: () => pending }
    await harness.callHook('agent_start', {}, context)
    await harness.callHook(
      'agent_end',
      { messages: [{ role: 'assistant', stopReason: 'stop' }] },
      context
    )
    await vi.waitFor(() =>
      expect(rows.at(-1)).toMatchObject({ state: 'working', mainAgent: { outcome: 'success' } })
    )
    if (settled) {
      await harness.callHook('agent_settled', {}, context)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(rows.at(-1)?.state).toBe('working')
    pending = false
    await vi.waitFor(() =>
      expect(rows.at(-1)).toMatchObject({ state: 'done', mainAgent: { outcome: 'success' } })
    )
  })

  it.each(['auto_retry', 'auto_compaction'])(
    'keeps %s active until terminal agent_end',
    async (phase) => {
      const { harness, rows } = createStatusScenario()
      await harness.callHook(`${phase}_start`, {}, idle)
      await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('working'))
      await harness.callHook(`${phase}_end`, { willRetry: true }, idle)
      await harness.callHook('agent_end', { willContinue: true }, idle)
      await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('working'))
      expect(rows.some((row) => row.state === 'done')).toBe(false)
      await harness.callHook(
        'agent_end',
        { messages: [{ role: 'assistant', stopReason: 'stop' }] },
        idle
      )
      await vi.waitFor(() => expect(rows.at(-1)?.mainAgent?.outcome).toBe('success'))
    }
  )

  it.each([
    ['stop', 'success'],
    ['error', 'failure'],
    ['aborted', 'cancellation'],
    ['length', undefined],
    ['toolUse', undefined]
  ] as const)(
    'maps observed %s without treating every completion as success',
    async (stopReason, outcome) => {
      const { harness, rows } = createStatusScenario()
      await harness.callHook('agent_start', {}, idle)
      await harness.callHook('agent_end', { messages: [{ role: 'assistant', stopReason }] }, idle)
      await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('done'))
      expect(rows.at(-1)?.mainAgent?.outcome).toBe(outcome)
      expect(rows.at(-1)?.interrupted).toBe(outcome === 'cancellation' ? true : undefined)
    }
  )

  it.each([false, true])(
    'preserves the job outcome clock with settled event %s',
    async (settled) => {
      const { harness, rows } = createStatusScenario()
      let running = true
      const context = { ...idle, getAsyncJobSnapshot: () => ({ running: running ? [{}] : [] }) }
      await harness.callHook('agent_start', {}, context)
      await harness.callHook(
        'agent_end',
        { messages: [{ role: 'assistant', stopReason: 'error' }] },
        context
      )
      await vi.waitFor(() =>
        expect(rows.at(-1)).toMatchObject({
          state: 'working',
          mainAgent: { state: 'done', outcome: 'failure' }
        })
      )
      const clock = rows.at(-1)?.mainAgent?.stateStartedAt
      if (settled) {
        await harness.callHook('agent_settled', {}, context)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(rows.at(-1)?.state).toBe('working')
      running = false
      await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('done'))
      expect(rows.at(-1)?.mainAgent).toMatchObject({ outcome: 'failure', stateStartedAt: clock })
    }
  )

  it('restores readiness after nested dialogs and ignores a late close from an old session', async () => {
    const { harness, rows } = createStatusScenario()
    const close: (() => void)[] = []
    const ui = {
      confirm: () => {
        const { promise, resolve } = Promise.withResolvers<boolean>()
        close.push(() => resolve(true))
        return promise
      }
    }
    const context = { ...idle, hasUI: true, ui }
    await harness.callHook('session_start', {}, context)
    const first = ui.confirm()
    const second = ui.confirm()
    await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('waiting'))
    close[0]()
    await first
    expect(rows.at(-1)?.state).toBe('waiting')
    close[1]()
    await second
    await vi.waitFor(() =>
      expect(rows.at(-1)).toMatchObject({ state: 'done', sessionBoundary: true })
    )
    const oldDialog = ui.confirm()
    await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('waiting'))
    await harness.callHook('session_switch', {}, { ...context, isIdle: () => false })
    await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('working'))
    const count = rows.length
    close[2]()
    await oldDialog
    expect(rows.length).toBe(count)
  })

  it('closes waiting state when a dialog rejects', async () => {
    const { harness, rows } = createStatusScenario()
    const ui = {
      confirm: async () => {
        throw new Error('dialog failed')
      }
    }
    await harness.callHook('session_start', {}, { ...idle, hasUI: true, ui })
    await expect(ui.confirm()).rejects.toThrow('dialog failed')
    await vi.waitFor(() =>
      expect(rows.at(-1)).toMatchObject({ state: 'done', sessionBoundary: true })
    )
  })

  it('tracks real handler UI proxy calls across an extension reload', async () => {
    const { harness, rows } = createStatusScenario()
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const sharedUi = { confirm: () => promise }
    const ui = new Proxy(sharedUi, {
      get(target, key, receiver) {
        if (key === 'confirm') {
          return () => target.confirm()
        }
        return Reflect.get(target, key, receiver)
      }
    })
    const context = { ...idle, hasUI: true, ui }
    await harness.callHook('session_start', {}, context)
    const dialog = ui.confirm()
    await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('waiting'))
    harness.reload()
    await harness.callHook('model_select', {}, context)
    await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('waiting'))
    resolve(true)
    expect(await dialog).toBe(true)
    await vi.waitFor(() =>
      expect(rows.at(-1)).toMatchObject({ state: 'done', sessionBoundary: true })
    )
  })

  it.each(['pi', 'omp'] as const)('ignores stale dialog closes after %s shutdown', async (kind) => {
    const { harness, rows } = createStatusScenario(kind)
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const ui = { confirm: () => promise }
    const context = { ...idle, hasUI: true, ui }
    await harness.callHook('session_start', {}, context)
    const dialog = ui.confirm()
    await vi.waitFor(() => expect(rows.at(-1)?.state).toBe('waiting'))
    await harness.callHook('session_shutdown', {}, context)
    resolve(true)
    await dialog
    expect(rows.at(-1)?.state).toBe('waiting')
  })
})
