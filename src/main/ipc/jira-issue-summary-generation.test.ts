import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  prepare: vi.fn(),
  generate: vi.fn(),
  cancel: vi.fn(),
  resolve: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.prepare
}))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  resolveTextGenerationParams: mocks.resolve
}))
vi.mock('../text-generation/jira-issue-summary-text-generation', () => ({
  generateJiraIssueSummaryFromContext: mocks.generate,
  cancelGenerateJiraIssueSummaryLocal: mocks.cancel
}))
import { registerJiraIssueSummaryGenerationHandlers } from './jira-issue-summary-generation'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function sender(id: number) {
  return Object.assign(new EventEmitter(), { id })
}
function handler(channel: string) {
  const callback = mocks.handle.mock.calls.find(([name]) => name === channel)?.[1]
  if (typeof callback !== 'function') {
    throw new Error(`Missing handler: ${channel}`)
  }
  return callback
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolve.mockReturnValue({
    ok: true,
    params: { agentId: 'custom', model: '', customAgentCommand: 'agent' }
  })
  mocks.prepare.mockResolvedValue({ ok: true })
  mocks.generate.mockResolvedValue({ success: true, summary: 'Generated title' })
  registerJiraIssueSummaryGenerationHandlers({ getSettings: vi.fn() })
})

describe('Jira title generation ownership', () => {
  it('does not launch an older request whose environment finishes after its replacement', async () => {
    const slow = deferred<{ ok: true }>()
    mocks.prepare.mockReturnValueOnce(slow.promise)
    const event = { sender: sender(1) }
    const generate = handler('jira:generateIssueSummary')
    const old = generate(event, { description: 'Old draft' })
    await generate(event, { description: 'New draft' })
    slow.resolve({ ok: true })
    expect(await old).toMatchObject({ canceled: true })
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    expect(mocks.generate.mock.calls[0][0]).toMatchObject({ description: 'New draft' })
  })

  it('ignores another window’s cancel and rejects its competing generation', async () => {
    const pending = deferred<{ success: true; summary: string }>()
    mocks.generate.mockReturnValue(pending.promise)
    const generate = handler('jira:generateIssueSummary')
    const first = generate({ sender: sender(1) }, { description: 'First' })
    await Promise.resolve()
    mocks.cancel.mockClear()
    handler('jira:cancelGenerateIssueSummary')({ sender: sender(2) })
    expect(await generate({ sender: sender(2) }, { description: 'Second' })).toMatchObject({
      success: false
    })
    expect(mocks.cancel).not.toHaveBeenCalled()
    pending.resolve({ success: true, summary: 'First title' })
    await first
  })

  it.each(['cancel', 'destroy'])(
    'prevents a spawn after %s during environment preparation',
    async (action) => {
      const pending = deferred<{ ok: true }>()
      mocks.prepare.mockReturnValue(pending.promise)
      const owner = sender(1)
      const request = handler('jira:generateIssueSummary')(
        { sender: owner },
        { description: 'Draft' }
      )
      if (action === 'cancel') {
        handler('jira:cancelGenerateIssueSummary')({ sender: owner })
      } else {
        owner.emit('destroyed')
      }
      pending.resolve({ ok: true })
      expect(await request).toMatchObject({ canceled: true })
      expect(mocks.generate).not.toHaveBeenCalled()
      expect(owner.listenerCount('destroyed')).toBe(0)
    }
  )
})
