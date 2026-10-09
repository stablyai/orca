import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { runClaudeControl } from './claude-agent-sdk-control-requests'
import { sessionFor } from './claude-structured-dispatch-test-support'
import { setClaudeStructuredOption } from './claude-structured-options'
import { prepareClaudePermissionMode } from './claude-structured-permission-application'
import { applyClaudeStartPermissionMode } from './claude-structured-start-permission-mode'
import { createClaudeInitProof } from './claude-structured-init-proof'

afterEach(() => vi.useRealTimers())

it('startup and preparation derive Ask after a pending explicit write owns the provider', async () => {
  const session = sessionFor()
  session.launchPermissionMode = 'bypass'
  session.appliedPermissionMode = 'bypass'
  session.options.set('permissionMode', 'bypass')
  let reply = () => {}
  const setPermissionMode = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        reply = resolve
      })
  )
  Object.assign(session.connection, { setPermissionMode })
  const picked = setClaudeStructuredOption(session, { key: 'permissionMode', value: 'ask' }, 50)
  await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledOnce())
  const startup = applyClaudeStartPermissionMode(session, {
    init: null,
    initProof: createClaudeInitProof(),
    initialization: { models: [] },
    resumesTranscript: false,
    requestTimeoutMs: 50
  })
  const preparation = prepareClaudePermissionMode(session, 50)
  expect(preparation).toBeDefined()
  expect(setPermissionMode.mock.calls).toHaveLength(1)
  reply()
  await expect(picked).resolves.toEqual({ permissionMode: 'ask' })
  await startup
  await preparation
  expect(setPermissionMode.mock.calls).toEqual([['default', { timeoutMs: 50 }]])
  expect(session.options.get('permissionMode')).toBe('ask')
  expect(session.appliedPermissionMode).toBe('ask')
  expect(prepareClaudePermissionMode(session, 50)).toBeUndefined()
})

it('a timed-out control reply cannot certify state after later permission controls', async () => {
  vi.useFakeTimers()
  const session = sessionFor()
  session.launchPermissionMode = 'bypass'
  session.appliedPermissionMode = 'bypass'
  session.options.set('permissionMode', 'bypass')
  let reply = () => {}
  let first = true
  let providerMode: PermissionMode = 'bypassPermissions'
  const setPermissionMode = vi.fn((mode: PermissionMode) =>
    runClaudeControl(
      'set_permission_mode',
      async () => {
        providerMode = mode
        if (first) {
          first = false
          await new Promise<void>((resolve) => {
            reply = resolve
          })
        }
      },
      50
    )
  )
  Object.assign(session.connection, { setPermissionMode })
  const lost = setClaudeStructuredOption(session, { key: 'permissionMode', value: 'ask' }, 50)
  const rejected = expect(lost).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(50)
  await rejected
  expect(session.appliedPermissionMode).toBeUndefined()
  const mutation = session.optionMutationSequence
  await prepareClaudePermissionMode(session, 50)
  expect(session.optionMutationSequence).toBe(mutation)
  expect(session.appliedPermissionMode).toBe('bypass')
  await setClaudeStructuredOption(session, { key: 'permissionMode', value: 'accept-edits' }, 50)
  reply()
  await vi.advanceTimersByTimeAsync(0)
  expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
    'default',
    'bypassPermissions',
    'acceptEdits'
  ])
  expect(session.options.get('permissionMode')).toBe('accept-edits')
  expect(session.appliedPermissionMode).toBe('accept-edits')
  expect(providerMode).toBe('acceptEdits')
})
