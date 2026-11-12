import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data')
}))
vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock(mocks)
})

import { main } from './index'
import { okFixture } from './test-fixtures'
import { RuntimeRpcFailureError } from './runtime/types'

function headlessRefusal(): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'req_open',
    ok: false,
    error: { code: 'runtime_error', message: 'renderer_unavailable' },
    _meta: { runtimeId: 'runtime-1' }
  })
}

describe('file commands on a server with no app window', () => {
  const priorExitCode = process.exitCode
  afterEach(() => {
    process.exitCode = priorExitCode
    vi.restoreAllMocks()
  })
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.callMock.mockReset()
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('stops open-changed at the first refusal with the same explanation', async () => {
    mocks.callMock
      .mockResolvedValueOnce(
        okFixture('req_status', {
          entries: [
            { path: 'a.ts', status: 'modified', area: 'unstaged' },
            { path: 'b.ts', status: 'modified', area: 'unstaged' }
          ]
        })
      )
      .mockRejectedValueOnce(headlessRefusal())

    await main(['file', 'open-changed', '--worktree', 'id:wt-1'], '/tmp/repo')

    expect(mocks.callMock.mock.calls).toEqual([
      ['git.status', { worktree: 'id:wt-1' }],
      [
        'files.openDiff',
        { worktree: 'id:wt-1', relativePath: 'a.ts', staged: false, navigation: 'caller' }
      ]
    ])

    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain(
      'This Orca server has no app window'
    )
  })
})
