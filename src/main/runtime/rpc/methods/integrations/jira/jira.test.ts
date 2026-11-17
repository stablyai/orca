import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcRequest } from '../../../core'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { JIRA_METHODS } from './jira'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('jira RPC methods', () => {
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
