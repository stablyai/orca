import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { remoteRpcContentBudget } from '../../../../shared/remote-rpc-content-budget'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../../shared/remote-runtime-memory-limits'
import { RpcDispatcher } from '../dispatcher'
import { GITLAB_METHODS } from './gitlab'

it.each(['mobile', 'runtime'] as const)(
  'bounds the complete GitLab reply for %s without closing the transport',
  async (clientKind) => {
    const getDetails = vi.fn().mockResolvedValue({ body: 'Details', comments: [] })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This dispatcher route uses only the two stubbed runtime methods.
    const runtime = {
      getRuntimeId: () => 'test',
      getGitLabRepoWorkItemDetails: getDetails
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })
    const request = {
      id: '\u0001'.repeat(8192),
      authToken: 'tok',
      method: 'gitlab.workItemDetails',
      params: { repo: 'id:repo', iid: 1, type: 'issue', includeImages: true }
    }
    const replies: string[] = []
    await dispatcher.dispatchStreaming(request, (reply) => replies.push(reply), { clientKind })
    expect(getDetails).toHaveBeenCalledWith('id:repo', 1, 'issue', undefined, {
      includeImages: true,
      maxReplyBytes: remoteRpcContentBudget(request.id)
    })
    expect(JSON.parse(replies[0])).toMatchObject({ ok: true, result: { body: 'Details' } })

    getDetails.mockResolvedValue({
      body: 'x'.repeat(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES),
      comments: []
    })
    await dispatcher.dispatchStreaming(request, (reply) => replies.push(reply), { clientKind })
    expect(JSON.parse(replies[1])).toMatchObject({ ok: false })
    expect(Buffer.byteLength(replies[1])).toBeLessThan(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES)

    getDetails.mockResolvedValue({ body: 'Still connected', comments: [] })
    await dispatcher.dispatchStreaming(request, (reply) => replies.push(reply), { clientKind })
    expect(JSON.parse(replies[2])).toMatchObject({ ok: true })
  }
)
