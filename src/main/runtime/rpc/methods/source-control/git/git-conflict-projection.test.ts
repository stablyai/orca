import { BranchSwitchLandedWithWarningError } from '../../../../../git/branch-switch'
import { mapDispatcherError } from '../../../dispatcher-error-response'
import '../../../unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { RpcDispatcher } from '../../../dispatcher'
import { GIT_METHODS } from './git'
import type { GitStatusResult } from '../../../../../../shared/git/status/git-status-types'

// The shared status object stands for the host cache; no caller may rewrite it.
describe('git conflict replies', () => {
  it('projects revert independently for each caller without changing the cached status', async () => {
    const status: GitStatusResult = { entries: [], conflictOperation: 'revert' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the two fixture methods are dispatched.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitStatus: async () => status,
      getRuntimeGitSubmoduleStatus: async () => status,
      getRuntimeGitConflictOperation: async () => 'revert'
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })
    for (const method of ['git.status', 'git.submoduleStatus', 'git.conflictOperation']) {
      const replies: string[] = []
      for (const capabilities of [[], ['git.conflict-operation.revert.v1'], []]) {
        await dispatcher.dispatchStreaming(
          {
            id: method,
            authToken: '',
            method,
            params: { worktree: 'id:workspace', submodulePath: 'sub' }
          },
          (reply) => replies.push(reply),
          { clientCapabilities: capabilities }
        )
      }
      expect(replies.map((reply) => JSON.parse(reply).result)).toEqual(
        method !== 'git.conflictOperation'
          ? [
              { entries: [], conflictOperation: 'unknown' },
              { entries: [], conflictOperation: 'revert' },
              { entries: [], conflictOperation: 'unknown' }
            ]
          : ['unknown', 'revert', 'unknown']
      )
    }
    expect(status).toEqual({ entries: [], conflictOperation: 'revert' })
  })
})

it('preserves a landed checkout warning across RPC without changing the legacy error code', () => {
  const reply = mapDispatcherError(
    { id: 'checkout', authToken: '', method: 'git.checkout' },
    { runtimeId: 'test-runtime' },
    new BranchSwitchLandedWithWarningError('Hook failed after checkout', 'feature')
  )
  expect(reply).toMatchObject({
    ok: false,
    error: { code: 'runtime_error', data: { outcome: 'landed-with-warning' } }
  })
})
