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

  it('explains the refusal instead of printing the raw token', async () => {
    mocks.callMock.mockRejectedValueOnce(headlessRefusal())

    await main(['file', 'open', 'src/App.tsx', '--worktree', 'id:wt-1'], '/tmp/repo')

    const printed = String(vi.mocked(console.error).mock.calls[0]?.[0])
    expect(printed).toContain('This Orca server has no app window')
    expect(printed).toContain('Next step: Open the file from the file explorer')
    expect(printed.split('\n')[0]).not.toBe('renderer_unavailable')
    expect(process.exitCode).toBe(1)
  })

  it('keeps a stable code and recovery in --json output', async () => {
    mocks.callMock.mockRejectedValueOnce(headlessRefusal())

    await main(
      ['file', 'diff', 'src/App.tsx', '--worktree', 'id:wt-1', '--focus', '--json'],
      '/tmp/repo'
    )

    const output = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))
    expect(output.ok).toBe(false)
    expect(output.error.code).toBe('renderer_unavailable')
    expect(output.error.message).toContain('no app window')
    expect(output.error.data.nextSteps).toEqual([
      expect.stringContaining('file explorer'),
      expect.stringContaining('path in your reply')
    ])
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

  it('leaves other runtime errors untouched', async () => {
    mocks.callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_open',
        ok: false,
        error: { code: 'runtime_error', message: 'chat_scratch_not_openable' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )

    await main(['file', 'open', 'src/App.tsx', '--worktree', 'id:wt-1'], '/tmp/repo')

    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toBe('chat_scratch_not_openable')
  })
})
