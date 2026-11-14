import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcRequest } from '../../../core'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { JIRA_METHODS } from './jira'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('jira RPC methods', () => {
  it('passes verified read requests and atomic label operations through RPC', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraGetIssue: vi.fn().mockResolvedValue(null),
      jiraIssueComments: vi.fn().mockResolvedValue([]),
      jiraUpdateIssue: vi.fn().mockResolvedValue({ ok: true })
    }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This dispatcher test only invokes the three methods implemented by the fixture.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: JIRA_METHODS
    })
    await dispatcher.dispatch(
      makeRequest('jira.getIssue', {
        key: 'ABC-1',
        siteId: 'site-1',
        strict: true,
        mediaFormat: 'reference'
      })
    )
    await dispatcher.dispatch(
      makeRequest('jira.issueComments', {
        key: 'ABC-1',
        siteId: 'site-1',
        strict: true,
        mediaFormat: 'reference'
      })
    )
    await dispatcher.dispatch(
      makeRequest('jira.updateIssue', {
        key: 'ABC-1',
        siteId: 'site-1',
        updates: { labelOperations: { add: ['bug'] } }
      })
    )
    expect(runtime.jiraGetIssue).toHaveBeenCalledWith('ABC-1', 'site-1', true, 'reference')
    expect(runtime.jiraIssueComments).toHaveBeenCalledWith('ABC-1', 'site-1', true, 'reference')
    expect(runtime.jiraUpdateIssue).toHaveBeenCalledWith(
      'ABC-1',
      { labelOperations: { add: ['bug'] } },
      'site-1'
    )
    const conflict = await dispatcher.dispatch(
      makeRequest('jira.updateIssue', {
        key: 'ABC-1',
        updates: { labels: ['replace'], labelOperations: { add: ['bug'] } }
      })
    )
    expect(conflict).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.jiraUpdateIssue).toHaveBeenCalledTimes(1)
  })

  it('streams Jira image-bearing payloads in bounded JSON chunks', async () => {
    const description = `![shot](data:image/png;base64,${'a'.repeat(300_000)})`
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraGetIssue: vi.fn().mockResolvedValue({ key: 'ABC-3', description })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('jira.getIssueStream', { key: 'ABC-3', siteId: 'site-1' }),
      (response) => replies.push(response)
    )

    const messages = replies.map(
      (response) => (JSON.parse(response) as { result: { type: string; content?: string } }).result
    )
    expect(messages.at(-1)).toEqual({ type: 'end' })
    expect(messages.filter((message) => message.type === 'chunk')).toHaveLength(2)
    const payload = messages.map((message) => message.content ?? '').join('')
    expect(JSON.parse(payload)).toEqual({ key: 'ABC-3', description })
  })

  it('reads raw edit-field values only when the caller asks for them', async () => {
    const jiraGetIssueEditFields = vi.fn().mockResolvedValue([])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the runtime identity and edit-field read are invoked by these requests.
    const runtime = {
      getRuntimeId: () => 'host-a',
      jiraGetIssueEditFields
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })
    const request = { key: 'ABC-3', siteId: 'site-1', strict: true }
    await dispatcher.dispatch(makeRequest('jira.getIssueEditFields', request))
    expect(jiraGetIssueEditFields).toHaveBeenLastCalledWith('ABC-3', 'site-1', true, undefined)
    await dispatcher.dispatch(
      makeRequest('jira.getIssueEditFields', { ...request, includeRaw: true })
    )
    expect(jiraGetIssueEditFields).toHaveBeenLastCalledWith('ABC-3', 'site-1', true, true)
  })
})

describe('Jira title generation RPC', () => {
  it('binds generation and stop to the authenticated device across one-shot sockets', async () => {
    const generate = vi.fn().mockResolvedValue({ success: true, summary: 'Title' })
    const cancel = vi.fn().mockReturnValue({ ok: true })
    const stub = {
      getRuntimeId: () => 'test-runtime',
      jiraGenerateIssueSummary: generate,
      jiraCancelGenerateIssueSummary: cancel
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods only use the three supplied runtime operations.
    const runtime = stub as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })
    const args = { siteId: 'site-1', requestId: 'req-1', draftId: 'draft-1', description: 'Draft' }
    const abort = new AbortController()
    await dispatcher.dispatch(makeRequest('jira.generateIssueSummary', args), {
      connectionId: 'connection-1',
      pairedDeviceId: 'device-1',
      signal: abort.signal
    })
    await dispatcher.dispatch(makeRequest('jira.cancelGenerateIssueSummary', args), {
      connectionId: 'connection-2',
      pairedDeviceId: 'device-1'
    })
    expect(generate).toHaveBeenCalledWith(args, 'device:device-1', abort.signal)
    await dispatcher.dispatch(makeRequest('jira.cancelGenerateIssueSummary', args), {
      connectionId: 'connection-3',
      pairedDeviceId: 'device-2'
    })
    expect(cancel).toHaveBeenLastCalledWith(
      { siteId: 'site-1', requestId: 'req-1', draftId: 'draft-1' },
      'device:device-2'
    )
    expect(cancel).toHaveBeenCalledWith(
      { siteId: 'site-1', requestId: 'req-1', draftId: 'draft-1' },
      'device:device-1'
    )
  })
})
