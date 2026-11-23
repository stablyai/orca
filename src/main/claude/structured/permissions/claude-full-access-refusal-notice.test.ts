import { expect, it, vi } from 'vitest'
import { claimClaudeFullAccessRefusalNotice } from './claude-full-access-refusal-notice'

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
