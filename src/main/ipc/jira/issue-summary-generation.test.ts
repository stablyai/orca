import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ handle: vi.fn(), generate: vi.fn(), cancel: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../text-generation/jira-issue-summary-requests', () => ({
  generateJiraIssueSummaryRequest: mocks.generate,
  cancelJiraIssueSummaryRequest: mocks.cancel
}))
import { registerJiraIssueSummaryGenerationHandlers } from './issue-summary-generation'
function handler(channel: string) {
  const callback = mocks.handle.mock.calls.find(([name]) => name === channel)?.[1]
  if (typeof callback !== 'function') {
    throw new Error(`Missing handler: ${channel}`)
  }
  return callback
}
const args = { description: 'Draft', siteId: 'site-1', requestId: 'req-1', draftId: 'draft-1' }
beforeEach(() => {
  vi.clearAllMocks()
  registerJiraIssueSummaryGenerationHandlers({ getSettings: vi.fn() })
})
describe('Jira generation IPC ownership', () => {
  it('binds generation and cancel to the sending window', async () => {
    const sender = Object.assign(new EventEmitter(), { id: 7 })
    mocks.generate.mockResolvedValue({ success: true, summary: 'Title' })
    await handler('jira:generateIssueSummary')({ sender }, args)
    expect(mocks.generate).toHaveBeenCalledWith(expect.anything(), 'window:7', args)
    handler('jira:cancelGenerateIssueSummary')({ sender: { id: 8 } }, args)
    expect(mocks.cancel).toHaveBeenCalledWith(
      'window:8',
      expect.objectContaining({ requestId: 'req-1' })
    )
    expect(sender.listenerCount('destroyed')).toBe(0)
  })
  it('cancels the exact draft request when its window is destroyed', async () => {
    const sender = Object.assign(new EventEmitter(), { id: 7 })
    let finish!: () => void
    mocks.generate.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const pending = handler('jira:generateIssueSummary')({ sender }, args)
    sender.emit('destroyed')
    expect(mocks.cancel).toHaveBeenCalledWith('window:7', args)
    finish()
    await pending
  })
  it('rejects an unscoped generation request', async () => {
    await expect(
      handler('jira:generateIssueSummary')({ sender: new EventEmitter() }, { description: 'Draft' })
    ).rejects.toThrow()
    expect(mocks.generate).not.toHaveBeenCalled()
  })
})
