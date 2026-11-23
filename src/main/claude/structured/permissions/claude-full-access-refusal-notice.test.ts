import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import { runClaudeControl } from '../../sdk-transport/claude-agent-sdk-control-requests'
import { claimClaudeFullAccessRefusalNotice } from './claude-full-access-refusal-notice'
import { claudeOwesPermissionFallback } from './claude-full-access-refusal'
import { setClaudeAllowedPermissionMode } from './claude-permission-mode-ladder'
import { claudeBuildPermissionMode } from './claude-plan-approval-mode'

it('sorts permission notice IDs across a base-36 digit boundary', () => {
  const clock = vi.spyOn(Date, 'now')
  const noticeAt = (time: number) => {
    clock.mockReturnValue(time)
    return claimClaudeFullAccessRefusalNotice({
      launchIntent: { permissionMode: 'auto' },
      autoDisabled: true,
      appliedInputOptions: new Map([['buildPermissionMode', 'default']]),
      fullAccessRefusalNotices: { process: 'process', count: 0 }
    })!.id
  }
  try {
    const before = noticeAt(36 ** 8 - 1)
    const after = noticeAt(36 ** 8)
    expect(before).toMatch(/^t00zzzzzzzz:/)
    expect(after).toMatch(/^t0100000000:/)
    expect([after, before].sort()).toEqual([before, after])
  } finally {
    clock.mockRestore()
  }
})

it('keeps one Ask warning across a repeated refusal and records a later auto recovery', async () => {
  const appliedInputOptions = new Map([['model', 'first-model']])
  const session = {
    launchIntent: { permissionMode: 'auto' },
    reportedOptions: {},
    appliedInputOptions,
    fullAccessRefusalNotices: { process: 'process', count: 0 },
    connection: {
      setPermissionMode: (mode: PermissionMode) =>
        runClaudeControl(
          'set_permission_mode',
          async () => {
            if (mode === 'auto' && appliedInputOptions.get('model') !== 'supported') {
              throw Object.assign(new Error('Model cannot use auto'), {
                errorClass: 'control_request_failed',
                errorCode: 'auto_mode_model'
              })
            }
          },
          null
        )
    }
  }
  const applyBuildMode = async () => {
    const mode = await setClaudeAllowedPermissionMode(session, claudeBuildPermissionMode(session))
    appliedInputOptions.set('buildPermissionMode', mode)
    return mode
  }

  expect(await applyBuildMode()).toBe('default')
  expect(claimClaudeFullAccessRefusalNotice(session)?.id).toMatch(/:auto-for-now:ask$/)
  expect(claudeOwesPermissionFallback(session)).toBe(false)

  appliedInputOptions.set('model', 'second-model')
  expect(claudeOwesPermissionFallback(session)).toBe(true)
  expect(await applyBuildMode()).toBe('default')
  expect(claimClaudeFullAccessRefusalNotice(session)).toBeNull()
  expect(claudeOwesPermissionFallback(session)).toBe(false)

  appliedInputOptions.set('model', 'supported')
  expect(claudeOwesPermissionFallback(session)).toBe(true)
  expect(await applyBuildMode()).toBe('auto')
  expect(claimClaudeFullAccessRefusalNotice(session)?.id).toMatch(/:restored:auto$/)
  expect(claimClaudeFullAccessRefusalNotice(session)).toBeNull()
})
