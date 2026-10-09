import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import {
  CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS,
  ClaudeControlRequestError,
  runClaudeControl
} from './claude-agent-sdk-control-requests'
import { sessionFor, userMessage } from './claude-structured-dispatch-test-support'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { setClaudeStructuredOption } from './claude-structured-options'
import { prepareClaudePermissionMode } from './claude-structured-permission-application'
import { claudeStructuredSessionOptionsFrom } from './claude-structured-session-options'

afterEach(() => vi.useRealTimers())

it.each(['timeout', 'transport'] as const)(
  'reestablishes saved Ask before sending after Full access applies with a lost %s reply',
  async (failure) => {
    vi.useFakeTimers()
    let provider: PermissionMode = 'bypassPermissions'
    let loseReply = false
    const session = sessionFor(
      vi.fn(async () => {
        expect(provider).toBe('default')
      })
    )
    session.launchPermissionMode = 'bypass'
    session.appliedPermissionMode = 'bypass'
    const setPermissionMode = vi.fn((mode: PermissionMode) =>
      runClaudeControl('set_permission_mode', async () => {
        provider = mode
        if (loseReply) {
          loseReply = false
          if (failure === 'transport') {
            throw new Error('Query closed before response received')
          }
          await new Promise<void>(() => {})
        }
      })
    )
    Object.assign(session.connection, { setPermissionMode })
    await setClaudeStructuredOption(session, { key: 'permissionMode', value: 'ask' }, undefined)
    loseReply = true
    const lost = setClaudeStructuredOption(
      session,
      { key: 'permissionMode', value: 'bypass' },
      undefined
    )
    const rejected = expect(lost).rejects.toThrow(
      failure === 'timeout' ? 'timed out' : 'Query closed'
    )
    await vi.advanceTimersByTimeAsync(CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS)
    await rejected
    expect(provider).toBe('bypassPermissions')
    expect(session.appliedPermissionMode).toBeUndefined()
    expect(session.options.get('permissionMode')).toBe('ask')
    expect(claudeStructuredSessionOptionsFrom(session, null).permissionModes?.current).toBe('ask')
    await prepareClaudePermissionMode(session, undefined)
    await expect(
      dispatchClaudeTurn(session, { body: userMessage([{ type: 'text', text: 'hello' }]) })
    ).resolves.toEqual({ state: 'admitted' })
    expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
      'default',
      'bypassPermissions',
      'default'
    ])
    expect(prepareClaudePermissionMode(session, undefined)).toBeUndefined()
  }
)

it('keeps confirmed Ask after an explicit provider refusal', async () => {
  const session = sessionFor()
  session.launchPermissionMode = 'bypass'
  session.options.set('permissionMode', 'ask')
  session.appliedPermissionMode = 'ask'
  const setPermissionMode = vi.fn(async () => {
    throw new ClaudeControlRequestError('set_permission_mode', 'refused')
  })
  Object.assign(session.connection, { setPermissionMode })
  await expect(
    setClaudeStructuredOption(session, { key: 'permissionMode', value: 'bypass' }, 1)
  ).rejects.toThrow('refused')
  expect(session.appliedPermissionMode).toBe('ask')
  expect(prepareClaudePermissionMode(session, 1)).toBeUndefined()
})

it('establishes the latest intent if it changes during preparation', async () => {
  const session = sessionFor()
  session.options.set('permissionMode', 'ask')
  const setPermissionMode = vi.fn(async (mode: PermissionMode) => {
    if (mode === 'default') {
      session.options.set('permissionMode', 'accept-edits')
      ++session.optionMutationSequence
    }
  })
  Object.assign(session.connection, { setPermissionMode })
  await prepareClaudePermissionMode(session, 1)
  expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual(['default', 'acceptEdits'])
  expect(session.appliedPermissionMode).toBe('accept-edits')
})

it.each(['ask', undefined] as const)(
  'leaves relaunch-only Full access to the host with applied mode %s',
  async (applied) => {
    const session = sessionFor()
    session.launchPermissionMode = 'ask'
    session.appliedPermissionMode = applied
    const setPermissionMode = vi.fn()
    Object.assign(session.connection, { setPermissionMode })
    await setClaudeStructuredOption(session, { key: 'permissionMode', value: 'bypass' }, 1)
    expect(prepareClaudePermissionMode(session, 1)).toBeUndefined()
    expect(setPermissionMode).not.toHaveBeenCalled()
    expect(session.options.get('permissionMode')).toBe('bypass')
    expect(session.appliedPermissionMode).toBe(applied)
  }
)

it('re-derives a relaunch-only choice made while live preparation is outstanding', async () => {
  const session = sessionFor()
  session.launchPermissionMode = 'ask'
  session.options.set('permissionMode', 'accept-edits')
  let finishApplication = () => {}
  const setPermissionMode = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishApplication = resolve
      })
  )
  Object.assign(session.connection, { setPermissionMode })
  const preparing = prepareClaudePermissionMode(session, 1)
  await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledOnce())
  const picked = setClaudeStructuredOption(session, { key: 'permissionMode', value: 'bypass' }, 1)
  finishApplication()
  await picked
  await preparing
  expect(setPermissionMode.mock.calls).toEqual([['acceptEdits', { timeoutMs: 1 }]])
  expect(session.options.get('permissionMode')).toBe('bypass')
  expect(session.appliedPermissionMode).toBe('accept-edits')
  expect(prepareClaudePermissionMode(session, 1)).toBeUndefined()
})
