import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

function dispatchOpen(params: Record<string, unknown>) {
  const openMobileFile = vi.fn().mockResolvedValue({
    worktree: 'wt-1',
    relativePath: params.relativePath,
    kind: 'markdown',
    opened: true
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: files.open calls only openMobileFile on this runtime fixture.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    openMobileFile
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
  const response = dispatcher.dispatch({
    id: 'req-1',
    authToken: 'tok',
    method: 'files.open',
    params: { worktree: 'id:wt-1', ...params }
  })
  return { openMobileFile, response }
}

describe('files.open', () => {
  it('opens a relative file path for a selected worktree', async () => {
    const { openMobileFile, response } = dispatchOpen({ relativePath: 'docs/readme.md' })

    expect(await response).toMatchObject({ ok: true, result: { kind: 'markdown', opened: true } })
    expect(openMobileFile).toHaveBeenCalledWith('id:wt-1', 'docs/readme.md', undefined)
  })

  it('threads preview to the runtime', async () => {
    const { openMobileFile, response } = dispatchOpen({ relativePath: 'a.html', preview: true })

    await response
    expect(openMobileFile).toHaveBeenCalledWith('id:wt-1', 'a.html', undefined, undefined, true)
  })
})
