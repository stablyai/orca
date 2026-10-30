import { expect, it, vi } from 'vitest'
import { ClaudeControlRequestTimeoutError } from './claude-agent-sdk-control-requests'
import type { ClaudeStructuredSessionEvent } from './structured/claude-structured-session-state'
import {
  acquired,
  claudeFrame,
  fakeClaude,
  tick,
  USER_MESSAGE
} from './claude-structured-session-test-support'

it.each(['before-settlement', 'after-settlement'])(
  'retires result settings begun during an uncertain control: %s',
  async (release) => {
    const control = Promise.withResolvers<void>()
    const report = Promise.withResolvers<unknown>()
    const events: ClaudeStructuredSessionEvent[] = []
    const native = fakeClaude({ routes: { set_model: () => control.promise } })
    const adapter = await acquired(native, {}, events)
    const connection = native.connections[0]!
    const session = adapter['sessions'].get('session-1')!
    const read = () => adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    const finishTurn = () =>
      claudeFrame(connection, {
        type: 'result',
        subtype: 'success',
        result: 'previous turn completed',
        is_error: false
      })
    try {
      await adapter.setOption({ sessionId: 'session-1', fence: 7, key: 'fastMode', value: 'true' })
      await tick()
      await adapter.dispatch({
        sessionId: 'session-1',
        fence: 7,
        clientMessageId: 'first',
        body: USER_MESSAGE
      })
      finishTurn()
      await tick()
      const writing = adapter.dispatch({
        sessionId: 'session-1',
        fence: 7,
        clientMessageId: 'next',
        body: USER_MESSAGE,
        executionOptions: { model: 'claude-opus-5' }
      })
      await vi.waitFor(() =>
        expect(connection.calls.some((call) => call.subtype === 'set_model')).toBe(true)
      )
      const settings = vi.spyOn(connection, 'getSettings').mockReturnValueOnce(report.promise)
      finishTurn()
      await vi.waitFor(() => expect(settings).toHaveBeenCalledOnce())
      const stale = {
        applied: { model: 'claude-sonnet-5', effort: 'low' },
        effective: { effortLevel: 'low', fastMode: false }
      }
      if (release === 'before-settlement') {
        report.resolve(stale)
        await tick()
        expect((await read()).current.fastMode).toBe(true)
        expect(session.appliedOptions).toBeUndefined()
      }
      control.reject(new ClaudeControlRequestTimeoutError('set_model'))
      expect(await writing).toMatchObject({ state: 'rejected' })
      report.resolve(stale)
      await tick()
      const current = (await read()).current
      expect(current).toMatchObject({ effort: 'high', fastMode: true })
      expect(current.confirmed ?? []).not.toContain('fastMode')
      expect(session.appliedOptions).toBeUndefined()
      expect(Object.fromEntries(session.appliedInputOptions)).toEqual({})
      expect(
        events.some(
          (event) => event.type === 'options-reported' && event.reportedOptions.effort === 'low'
        )
      ).toBe(false)

      native.routes.set_model = () => undefined
      await adapter.setOption({ sessionId: 'session-1', fence: 7, key: 'model', value: 'opus' })
      settings.mockResolvedValueOnce({
        applied: { model: 'claude-opus-5', effort: 'medium' },
        effective: { effortLevel: 'medium', fastMode: true }
      })
      finishTurn()
      await vi.waitFor(async () =>
        expect((await read()).current).toMatchObject({ effort: 'medium', fastMode: true })
      )
      expect(session.appliedInputOptions.get('model')).toBe('opus')
      expect(session.appliedOptions).toEqual({ model: 'claude-opus-5', effort: 'medium' })
    } finally {
      report.resolve(null)
      control.resolve()
      await adapter.closeSession('session-1')
    }
  }
)
