// Why: git.diff, git.branchDiff and git.commitDiff all return a GitDiffResult, so capping only the
// first would leave the other two able to kill a remote socket.
import { describe, expect, it, vi } from 'vitest'
import {
  REMOTE_RPC_MAX_CONTENT_BYTES,
  remoteRpcContentBudget
} from '../../../../shared/remote-rpc-content-budget'
import { assertGitDiffWithinTransportBudget } from '../../../../shared/git-diff-transport-budget'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeGitCommands, type ResolvedRuntimeGitWorktree } from '../../orca-runtime-git'
import type { RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { GIT_METHODS } from './git'

const sshMocks = vi.hoisted(() => ({ getSshGitProvider: vi.fn() }))

vi.mock('../../../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: sshMocks.getSshGitProvider
}))

const OVERSIZED_BASE64 = 'A'.repeat(REMOTE_RPC_MAX_CONTENT_BYTES + 1024)

const OVERSIZED_DIFF: GitDiffResult = {
  kind: 'binary',
  originalContent: '',
  modifiedContent: OVERSIZED_BASE64,
  isImage: true,
  mimeType: 'image/png',
  originalIsBinary: false,
  modifiedIsBinary: true
}

const CASES: readonly { method: string; runtimeMethod: string; params: Record<string, unknown> }[] =
  [
    {
      method: 'git.diff',
      runtimeMethod: 'getRuntimeGitDiff',
      params: { worktree: 'id:wt-1', filePath: 'assets/logo.png', staged: false }
    },
    {
      method: 'git.branchDiff',
      runtimeMethod: 'getRuntimeGitBranchDiff',
      params: {
        worktree: 'id:wt-1',
        compare: { mergeBase: 'a'.repeat(40), headOid: 'b'.repeat(40) },
        filePath: 'assets/logo.png'
      }
    },
    {
      method: 'git.commitDiff',
      runtimeMethod: 'getRuntimeGitCommitDiff',
      params: { worktree: 'id:wt-1', commitOid: 'c'.repeat(40), filePath: 'assets/logo.png' }
    }
  ]

/** Stands in for orca-runtime-git.ts, which enforces the budget it is handed as its last argument. */
function stubRuntime(runtimeMethod: string): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    [runtimeMethod]: vi.fn(async (...args: unknown[]) => {
      const maxContentBytes = args.at(-1)
      return assertGitDiffWithinTransportBudget(
        OVERSIZED_DIFF,
        typeof maxContentBytes === 'number' ? maxContentBytes : undefined
      )
    })
  } as unknown as OrcaRuntimeService
}

function budgetArgument(runtime: OrcaRuntimeService, runtimeMethod: string): unknown {
  const spy = (runtime as unknown as Record<string, ReturnType<typeof vi.fn>>)[runtimeMethod]!
  return spy.mock.calls[0]!.at(-1)
}

function makeRequest(method: string, params: Record<string, unknown>): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

async function dispatchRemote(
  runtime: OrcaRuntimeService,
  method: string,
  params: Record<string, unknown>,
  clientKind: 'mobile' | 'runtime'
): Promise<RpcResponse> {
  const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })
  const replies: string[] = []
  await dispatcher.dispatchStreaming(makeRequest(method, params), (reply) => replies.push(reply), {
    clientKind
  })
  return JSON.parse(replies[0]!) as RpcResponse
}

describe('remote git diff transport budget', () => {
  it.each(CASES)('caps $method for a mobile client', async ({ method, runtimeMethod, params }) => {
    const runtime = stubRuntime(runtimeMethod)

    const response = await dispatchRemote(runtime, method, params, 'mobile')

    expect(budgetArgument(runtime, runtimeMethod)).toBe(remoteRpcContentBudget('req-1'))
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'diff_too_large', data: { maxBytes: remoteRpcContentBudget('req-1') } }
    })
  })

  it.each(CASES)(
    'caps $method for a remote desktop client',
    async ({ method, runtimeMethod, params }) => {
      const runtime = stubRuntime(runtimeMethod)

      const response = await dispatchRemote(runtime, method, params, 'runtime')

      expect(budgetArgument(runtime, runtimeMethod)).toBe(remoteRpcContentBudget('req-1'))
      expect(response).toMatchObject({ ok: false, error: { code: 'diff_too_large' } })
    }
  )

  it('charges a long request id against the remote content budget', async () => {
    const runtime = stubRuntime('getRuntimeGitDiff')
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })
    const requestId = '\u0001'.repeat(8_192)
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      { ...makeRequest('git.diff', CASES[0]!.params), id: requestId },
      (reply) => replies.push(reply),
      { clientKind: 'mobile' }
    )

    expect(budgetArgument(runtime, 'getRuntimeGitDiff')).toBe(remoteRpcContentBudget(requestId))
    expect(Buffer.byteLength(replies[0]!, 'utf8')).toBeLessThanOrEqual(
      REMOTE_RPC_MAX_CONTENT_BYTES + 8 * 1024
    )
  })

  // Why: the in-process/Unix-socket context sets no clientKind, so desktop-local diffs keep full fidelity.
  it.each(CASES)(
    'leaves $method uncapped for a local caller',
    async ({ method, runtimeMethod, params }) => {
      const runtime = stubRuntime(runtimeMethod)
      const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

      const response = await dispatcher.dispatch(makeRequest(method, params))

      expect(budgetArgument(runtime, runtimeMethod)).toBeUndefined()
      expect(response).toMatchObject({
        ok: true,
        result: { kind: 'binary', modifiedContent: OVERSIZED_BASE64 }
      })
    }
  )

  // Why: an SSH host forwards its provider's payload verbatim, so the cap cannot rely on the far
  // side clamping — this walks the real RuntimeGitCommands with an unclamped forwarded diff.
  it('caps an SSH-forwarded diff a remote client requested', async () => {
    sshMocks.getSshGitProvider.mockReturnValue({
      getDiff: vi.fn().mockResolvedValue(OVERSIZED_DIFF)
    })
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: { id: 'wt-1', path: '/remote/repo' } as unknown as ResolvedRuntimeGitWorktree,
        connectionId: 'conn-1'
      }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })
    const runtime = Object.assign(commands, {
      getRuntimeId: () => 'test-runtime'
    }) as unknown as OrcaRuntimeService

    const response = await dispatchRemote(runtime, 'git.diff', CASES[0]!.params, 'mobile')

    expect(response).toMatchObject({ ok: false, error: { code: 'diff_too_large' } })
  })
})
