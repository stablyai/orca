import { expect, it, vi } from 'vitest'
import {
  finishPermissionCatchUp,
  permissionTestSession,
  savedNotice
} from './__tests__/claude-permission.test-fixture'
import {
  claimClaudeFullAccessRefusalNotice,
  readClaudeEarlierRefusalNotice
} from './claude-full-access-refusal-notice'

it('recovers the earlier warning after one transient journal lookup failure', async () => {
  const { session, frame, rows } = permissionTestSession('bypassPermissions')
  const newestItemId = vi
    .fn()
    .mockRejectedValueOnce(new Error('Reader exited'))
    .mockResolvedValueOnce(savedNotice('settings:ask'))
  await readClaudeEarlierRefusalNotice(session, { newestItemId }, () => {})

  frame('init', 'bypassPermissions')
  finishPermissionCatchUp(session)
  expect(rows).toEqual(['Claude uses Full access again.'])
})

it('sorts permission notice IDs across a base-36 digit boundary', () => {
  const clock = vi.spyOn(Date, 'now')
  const noticeAt = (time: number) => {
    clock.mockReturnValue(time)
    const { session } = permissionTestSession('auto')
    session.autoDisabled = true
    session.appliedInputOptions.set('buildPermissionMode', 'default')
    session.initialization.startup.open()
    return claimClaudeFullAccessRefusalNotice(session)?.id
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
