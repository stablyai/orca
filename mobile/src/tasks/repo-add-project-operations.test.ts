import { describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { RpcIncompatibleReplyError } from '../transport/rpc-incompatible-reply-error'
import type { RpcResponse } from '../transport/types'
import { repoAddExistingRun, repoCloneRun, repoCreateRun } from './repo-add-project-operations'
import { REPO_CLONE_TIMEOUT_MS } from './workspace-create-timeout'

function success(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

function refusal(message: string): RpcResponse {
  return {
    id: 'reply',
    ok: false,
    error: { code: 'runtime_error', message },
    _meta: { runtimeId: 'runtime' }
  }
}

function replyWith(response: RpcResponse): FakeSession {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(response)
  return client
}

const repoRow = {
  id: 'repo-1',
  path: '/srv/orca',
  displayName: 'orca',
  badgeColor: '#aabbcc',
  kind: 'git'
}

describe('repo add-project operations', () => {
  it('clone sends only the URL with the long-op budget and returns the repo row', async () => {
    const client = replyWith(success({ repo: repoRow }))
    const reply = await repoCloneRun.request(
      client,
      { url: 'https://example.com/orca.git' },
      { timeoutMs: REPO_CLONE_TIMEOUT_MS }
    )
    expect(client.sendRequest.mock.calls).toEqual([
      ['repo.clone', { url: 'https://example.com/orca.git' }, { timeoutMs: REPO_CLONE_TIMEOUT_MS }]
    ])
    expect(repoCloneRun.interpret(reply)).toEqual({ repo: repoRow })
  })

  it('clone surfaces the host message on a refusal', async () => {
    const reply = await repoCloneRun.request(replyWith(refusal('clone failed')), {
      url: 'https://example.com/orca.git'
    })
    expect(() => repoCloneRun.interpret(reply)).toThrow('clone failed')
  })

  it('clone rejects a reply without the repo trio rather than rendering a blank row', async () => {
    const reply = await repoCloneRun.request(replyWith(success({ repo: { id: 'repo-1' } })), {
      url: 'https://example.com/orca.git'
    })
    expect(() => repoCloneRun.interpret(reply)).toThrow(RpcIncompatibleReplyError)
  })

  it('create sends name and git kind, keeping the soft error arm for the caller', async () => {
    const client = replyWith(success({ repo: repoRow }))
    const reply = await repoCreateRun.request(client, { name: 'orca', kind: 'git' })
    expect(client.sendRequest.mock.calls).toEqual([['repo.create', { name: 'orca', kind: 'git' }]])
    const created = repoCreateRun.interpret(reply)
    expect('error' in created).toBe(false)
    expect(created).toEqual({ repo: repoRow })

    const refused = await repoCreateRun.request(
      replyWith(success({ error: 'Name cannot be empty' })),
      { name: 'orca', kind: 'git' }
    )
    const softError = repoCreateRun.interpret(refused)
    expect('error' in softError && softError.error).toBe('Name cannot be empty')
  })

  it('add sends only the host path', async () => {
    const client = replyWith(success({ repo: repoRow }))
    const reply = await repoAddExistingRun.request(client, { path: '/srv/orca' })
    expect(client.sendRequest.mock.calls).toEqual([['repo.add', { path: '/srv/orca' }]])
    expect(repoAddExistingRun.interpret(reply)).toEqual({ repo: repoRow })
  })

  it('add surfaces the host message on a refusal', async () => {
    const reply = await repoAddExistingRun.request(
      replyWith(refusal('Not a valid git repository: /srv/nope')),
      {
        path: '/srv/nope'
      }
    )
    expect(() => repoAddExistingRun.interpret(reply)).toThrow(
      'Not a valid git repository: /srv/nope'
    )
  })
})
