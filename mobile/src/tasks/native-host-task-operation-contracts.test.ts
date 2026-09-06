import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { nativeHostTaskItemFileOperations } from './native-host-task-item-file-operations'
import { nativeHostTaskListOperations } from './native-host-task-list-operations'
import { nativeHostTaskProjectFileOperations } from './native-host-task-project-file-operations'
import { nativeHostTaskProjectMutationOperations } from './native-host-task-project-mutation-operations'

function client(sendRequest: RpcClient['sendRequest']): RpcClient {
  return { sendRequest } as unknown as RpcClient
}

const itemTarget = { repoId: 'repo-1', number: 7 }
const projectTarget = { number: 7, slug: { owner: 'orca', repo: 'orca' }, type: 'pr' as const }

describe('native host task operation contracts', () => {
  it('rejects a non-array checks payload instead of crashing the checks list', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValue({ ok: true, result: { error: 'rate limited' } })

    await expect(
      nativeHostTaskItemFileOperations(client(sendRequest)).refreshChecks(itemTarget, 'sha')
    ).rejects.toThrow('Invalid checks response')
    await expect(
      nativeHostTaskProjectFileOperations(client(sendRequest)).refreshChecks(
        projectTarget,
        'repo-1',
        'sha'
      )
    ).rejects.toThrow('Invalid checks response')
  })

  it('reads an absent GitLab todo list as empty rather than an error banner', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValue({ ok: true, result: null })

    await expect(
      nativeHostTaskListOperations(client(sendRequest)).listGitLabTodos('repo-1')
    ).resolves.toEqual([])
  })

  it('gives project merge and rerun the long timeout their item-level twins use', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      ok: true,
      result: { ok: true }
    })
    const operations = nativeHostTaskProjectMutationOperations(client(sendRequest))

    await operations.rerunChecks(projectTarget, 'repo-1', { failedOnly: true })
    await operations.merge(projectTarget, 'repo-1', 'squash')

    for (const call of sendRequest.mock.calls) {
      expect(call[2]).toEqual({ timeoutMs: 60_000 })
    }
  })
})
