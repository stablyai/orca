import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import {
  adapterAtPublishFor,
  adapterFor,
  fakeClaude,
  identityFor,
  USER_MESSAGE,
  claudeStartupSettled
} from './claude-structured-session-test-support'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'

afterEach(() => vi.useRealTimers())

const ACQUIRE = { identity: identityFor(), fence: 7, spawnToken: 'spawn-9' }
const PROMPT = { sessionId: 'session-1', clientMessageId: 'client-1', body: USER_MESSAGE, fence: 7 }

describe('inherited Claude chat permissions before the first message', () => {
  it.each([
    ['accept-edits', true, 'acceptEdits', 'accept-edits'],
    ['auto', true, 'auto', 'auto'],
    ['auto', false, 'default', 'ask'],
    ['auto', undefined, 'default', 'ask']
  ] as const)(
    'applies inherited %s with auto support %s before input',
    async (permissionMode, supportsAutoMode, sdkMode, expected) => {
      vi.useFakeTimers()
      const claude = fakeClaude({
        initDelayMs: 1000,
        initModels: [
          { value: 'default', resolvedModel: 'claude-sonnet' },
          { value: 'sonnet', resolvedModel: 'claude-sonnet', supportsAutoMode }
        ],
        routes: {
          set_permission_mode: () => {
            expect(claude.connections[0].sent).toEqual([])
            return {}
          }
        }
      })
      const events: ClaudeStructuredSessionEvent[] = []
      const adapter = adapterAtPublishFor(
        claude,
        { permissionMode, options: { permissionMode: 'default' } },
        events
      )
      await adapter.acquire(ACQUIRE)
      const sent = Promise.resolve(adapter.prepareDispatch('session-1')).then(() =>
        adapter.dispatch(PROMPT)
      )
      expect(claude.connections[0].sent).toEqual([])
      await vi.advanceTimersByTimeAsync(1000)
      await claudeStartupSettled(adapter, 'session-1')
      await expect(sent).resolves.toMatchObject({ state: 'admitted' })
      expect(claude.connections[0].calls).toContainEqual({
        subtype: 'set_permission_mode',
        params: { mode: sdkMode }
      })
      expect(events.find((event) => event.type === 'started')).toMatchObject({
        reportedOptions: { permissionMode: expected }
      })
      await adapter.closeAll()
    }
  )

  it.each(['accept-edits', 'auto'] as const)(
    'falls back to Ask when the CLI refuses inherited %s',
    async (permissionMode) => {
      let first = true
      const claude = fakeClaude({
        initModels: [
          { value: 'default', resolvedModel: 'claude-sonnet' },
          { value: 'sonnet', resolvedModel: 'claude-sonnet', supportsAutoMode: true }
        ],
        routes: {
          set_permission_mode: () => {
            expect(claude.connections[0].sent).toEqual([])
            if (first) {
              first = false
              throw new ClaudeControlRequestError(
                'set_permission_mode',
                'Cannot transition to this mode'
              )
            }
            return {}
          }
        }
      })
      const events: ClaudeStructuredSessionEvent[] = []
      const adapter = adapterAtPublishFor(
        claude,
        { permissionMode, options: { permissionMode: 'default' } },
        events
      )
      await adapter.acquire(ACQUIRE)
      await adapter.prepareDispatch('session-1')
      await expect(adapter.dispatch(PROMPT)).resolves.toMatchObject({ state: 'admitted' })
      expect(
        claude.connections[0].calls
          .filter((call) => call.subtype === 'set_permission_mode')
          .map((call) => call.params?.mode)
      ).toEqual([permissionMode === 'auto' ? 'auto' : 'acceptEdits', 'default'])
      expect(events.find((event) => event.type === 'started')).toMatchObject({
        reportedOptions: { permissionMode: 'ask' }
      })
      await adapter.closeAll()
    }
  )
})

describe('saved Claude chat permissions', () => {
  it.each([true, false])(
    'prepares saved Auto and persists its supported mode (%s)',
    async (supportsAutoMode) => {
      const claude = fakeClaude({ initModels: [{ value: 'sonnet', supportsAutoMode }] })
      const events: ClaudeStructuredSessionEvent[] = []
      const adapter = adapterAtPublishFor(
        claude,
        { permissionMode: 'auto', options: { permissionMode: 'default' } },
        events
      )
      await adapter.acquire({ ...ACQUIRE, options: { model: 'sonnet', permissionMode: 'auto' } })
      await adapter.prepareDispatch('session-1')
      expect(events.find((event) => event.type === 'started')).toMatchObject({
        reportedOptions: { permissionMode: supportsAutoMode ? 'auto' : 'ask' }
      })
      expect(adapter['sessions'].get('session-1')?.options.get('permissionMode')).toBe(
        supportsAutoMode ? 'auto' : 'ask'
      )
      await adapter.closeAll()
    }
  )

  it('persists Ask for an unknown saved permission mode', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { permissionMode: 'retired-mode' }
    })
    expect(adapter.readOptionRestoreFailures('session-1')).toEqual([])
    expect(claude.connections[0].launch.options.permissionMode).toBe('default')
    expect(
      (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).permissionModes?.current
    ).toBe('ask')
    await adapter.closeAll()
  })
})
