import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest, RpcResponse } from '../core'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { GITHUB_ACTIONS_METHODS } from './github-actions-methods'
import {
  createArtifactSession,
  readArtifactSession,
  releaseArtifactSession
} from '../../../github/client/actions/artifact-download-sessions'

const params = {
  repo: 'artifact-repo',
  repository: { owner: 'acme', repo: 'widgets', host: 'github.com' },
  runId: 1,
  artifactId: 1
}
const request: RpcRequest = {
  id: 'artifact-request',
  authToken: 'token',
  method: 'github.startActionsArtifactDownload',
  params
}

async function invoke(
  dispatcher: RpcDispatcher,
  transport: 'unary' | 'streaming',
  options: RpcDispatchStreamingOptions,
  call: RpcRequest = request
): Promise<RpcResponse> {
  if (transport === 'unary') {
    return dispatcher.dispatch(call, options)
  }
  const replies: RpcResponse[] = []
  await dispatcher.dispatchStreaming(call, (raw) => replies.push(JSON.parse(raw)), options)
  const reply = replies[0]
  if (!reply) {
    throw new Error('Missing RPC reply')
  }
  return reply
}

describe.each(['unary', 'streaming'] as const)('Actions admission on %s transport', (transport) => {
  it('declares workspace permission and refuses non-allowlisted mobile callers before retaining a lifetime', async () => {
    const runtime = new OrcaRuntimeService()
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_ACTIONS_METHODS })
    const retainConnectionLifetime = vi.fn()
    const start = vi.spyOn(runtime, 'startRepoActionsArtifactDownload')
    for (const method of GITHUB_ACTIONS_METHODS) {
      expect(method.permission).toBe('workspace')
      const reply = await invoke(
        dispatcher,
        transport,
        {
          callerScope: { kind: 'mobile' },
          retainConnectionLifetime
        },
        { ...request, method: method.name }
      )
      expect(reply).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(retainConnectionLifetime).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('retains paired-client transfers after the request ends and releases them on disconnect', async () => {
    const runtime = new OrcaRuntimeService()
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_ACTIONS_METHODS })
    const connection = new AbortController()
    const requestLifetime = new AbortController()
    const dispose = vi.fn()
    const start = vi
      .spyOn(runtime, 'startRepoActionsArtifactDownload')
      .mockImplementation(async (repo, _query, signal, onRelease) =>
        createArtifactSession(repo, Buffer.from('ZIP'), 'fixture.zip', signal, onRelease)
      )
    const reply = await invoke(dispatcher, transport, {
      callerScope: { kind: 'runtime-paired', grants: [] },
      signal: requestLifetime.signal,
      retainConnectionLifetime: () => ({ signal: connection.signal, dispose })
    })
    expect(reply.ok).toBe(true)
    const transfer = await start.mock.results[0]?.value
    try {
      requestLifetime.abort()
      expect(readArtifactSession(transfer.transferId, params.repo, 0).done).toBe(true)
      expect(dispose).not.toHaveBeenCalled()
      connection.abort()
      expect(() => readArtifactSession(transfer.transferId, params.repo, 0)).toThrow('expired')
      expect(dispose).toHaveBeenCalledOnce()
    } finally {
      releaseArtifactSession(transfer.transferId, params.repo)
    }
  })

  it('disposes the retained lifetime when acquisition is cancelled', async () => {
    const runtime = new OrcaRuntimeService()
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_ACTIONS_METHODS })
    const connection = new AbortController()
    connection.abort()
    const dispose = vi.fn()
    vi.spyOn(runtime, 'startRepoActionsArtifactDownload').mockImplementation(
      async (_repo, _query, signal) => {
        signal?.throwIfAborted()
        throw new Error('Expected a cancelled signal')
      }
    )
    const reply = await invoke(dispatcher, transport, {
      callerScope: { kind: 'runtime-paired', grants: [] },
      retainConnectionLifetime: () => ({ signal: connection.signal, dispose })
    })
    expect(reply.ok).toBe(false)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('explicit release disposes the lifetime without needing a disconnect', async () => {
    const runtime = new OrcaRuntimeService()
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_ACTIONS_METHODS })
    const connection = new AbortController()
    const dispose = vi.fn()
    const start = vi
      .spyOn(runtime, 'startRepoActionsArtifactDownload')
      .mockImplementation(async (repo, _query, signal, onRelease) =>
        createArtifactSession(repo, Buffer.from('ZIP'), 'fixture.zip', signal, onRelease)
      )
    vi.spyOn(runtime, 'releaseRepoActionsArtifactDownload').mockImplementation((repo, query) => {
      releaseArtifactSession(query.transferId, repo)
      return Promise.resolve()
    })
    const options: RpcDispatchStreamingOptions = {
      callerScope: { kind: 'runtime-paired', grants: [] },
      retainConnectionLifetime: () => ({ signal: connection.signal, dispose })
    }
    expect((await invoke(dispatcher, transport, options)).ok).toBe(true)
    const transfer = await start.mock.results[0]?.value
    try {
      const reply = await invoke(dispatcher, transport, options, {
        ...request,
        method: 'github.releaseActionsArtifactDownload',
        params: { ...params, transferId: transfer.transferId }
      })
      expect(reply.ok).toBe(true)
      expect(dispose).toHaveBeenCalledOnce()
      expect(() => readArtifactSession(transfer.transferId, params.repo, 0)).toThrow('expired')
    } finally {
      releaseArtifactSession(transfer.transferId, params.repo)
    }
  })
})
