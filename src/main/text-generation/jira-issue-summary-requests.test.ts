import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  generate: vi.fn(),
  cancel: vi.fn(),
  resolve: vi.fn(),
  status: vi.fn()
}))
vi.mock('../jira/client', () => ({ getStatus: mocks.status }))
vi.mock('./commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.prepare
}))
vi.mock('./commit-message-text-generation', () => ({ resolveTextGenerationParams: mocks.resolve }))
vi.mock('./jira-issue-summary-text-generation', () => ({
  generateJiraIssueSummaryFromContext: mocks.generate,
  cancelGenerateJiraIssueSummaryLocal: mocks.cancel
}))
import {
  generateJiraIssueSummaryRequest,
  cancelJiraIssueSummaryRequest
} from './jira-issue-summary-requests'
import { getDefaultSettings } from '../../shared/constants'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const args = { description: 'Draft', siteId: 'site-1', requestId: 'req-1', draftId: 'draft-1' }
const settings = getDefaultSettings('/fixture')
const host = {
  getSettings: () => settings,
  getAgentEnvironment: () => ({ prepareForCodexLaunch: () => 'host-codex-home' })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolve.mockReturnValue({
    ok: true,
    params: { agentId: 'custom', model: '', customAgentCommand: 'agent' }
  })
  mocks.prepare.mockResolvedValue({ ok: true, env: { CODEX_HOME: 'host-codex-home' } })
  mocks.generate.mockResolvedValue({ success: true, summary: 'Generated title' })
  mocks.status.mockReturnValue({ sites: [{ id: 'site-1' }, { id: 'site-2' }] })
})
describe('Jira title host ownership', () => {
  it('uses the owning host settings and account environment', async () => {
    expect(await generateJiraIssueSummaryRequest(host, 'owner-1', args)).toMatchObject({
      success: true
    })
    expect(mocks.resolve).toHaveBeenCalledWith(settings, 'local', 'branchName', null)
    expect(mocks.prepare).toHaveBeenCalledWith(
      'custom',
      expect.objectContaining({ prepareForCodexLaunch: expect.any(Function) })
    )
    expect(mocks.generate).toHaveBeenCalledWith(
      args,
      expect.anything(),
      expect.objectContaining({ kind: 'local', env: { CODEX_HOME: 'host-codex-home' } })
    )
  })
  it('does not launch a replaced request after its environment finishes', async () => {
    const slow = deferred<{ ok: true }>()
    mocks.prepare.mockReturnValueOnce(slow.promise)
    const old = generateJiraIssueSummaryRequest(host, 'owner-1', args)
    await generateJiraIssueSummaryRequest(host, 'owner-1', {
      ...args,
      requestId: 'req-2',
      description: 'New'
    })
    slow.resolve({ ok: true })
    expect(await old).toMatchObject({ canceled: true })
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    expect(mocks.generate.mock.calls[0][0].description).toBe('New')
  })
  it.each([
    ['owner-2', args],
    ['owner-1', { ...args, draftId: 'draft-2' }],
    ['owner-1', { ...args, siteId: 'site-2' }]
  ])('rejects competing generation from another owner, draft or account', async (owner, other) => {
    const pending = deferred<{ success: true; summary: string }>()
    mocks.generate.mockReturnValue(pending.promise)
    const first = generateJiraIssueSummaryRequest(host, 'owner-1', args)
    await Promise.resolve()
    mocks.cancel.mockClear()
    cancelJiraIssueSummaryRequest(owner, other)
    expect(await generateJiraIssueSummaryRequest(host, owner, other)).toMatchObject({
      success: false
    })
    expect(mocks.cancel).not.toHaveBeenCalled()
    pending.resolve({ success: true, summary: 'First' })
    await first
  })
  it('ignores an old cancel after a newer request starts', async () => {
    const pending = deferred<{ ok: true }>()
    mocks.prepare.mockReturnValueOnce(pending.promise)
    const newer = { ...args, requestId: 'req-2' }
    const result = generateJiraIssueSummaryRequest(host, 'owner-1', newer)
    cancelJiraIssueSummaryRequest('owner-1', args)
    pending.resolve({ ok: true })
    expect(await result).toMatchObject({ success: true })
  })
  it.each(['cancel', 'disconnect'])(
    'prevents spawning after %s during environment preparation',
    async (action) => {
      const pending = deferred<{ ok: true }>()
      mocks.prepare.mockReturnValue(pending.promise)
      const abort = new AbortController()
      const result = generateJiraIssueSummaryRequest(host, 'owner-1', args, abort.signal)
      if (action === 'cancel') {
        cancelJiraIssueSummaryRequest('owner-1', args)
      } else {
        abort.abort()
      }
      pending.resolve({ ok: true })
      expect(await result).toMatchObject({ canceled: true })
      expect(mocks.generate).not.toHaveBeenCalled()
    }
  )
  it('rejects a Jira account absent on the execution host', async () => {
    expect(
      await generateJiraIssueSummaryRequest(host, 'owner-1', { ...args, siteId: 'unknown' })
    ).toMatchObject({ success: false })
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
  it('rechecks a disconnected Jira account before spawning', async () => {
    mocks.status.mockReturnValueOnce({ sites: [{ id: 'site-1' }] }).mockReturnValue({ sites: [] })
    expect(await generateJiraIssueSummaryRequest(host, 'owner-1', args)).toMatchObject({
      success: false
    })
    expect(mocks.generate).not.toHaveBeenCalled()
  })
})
