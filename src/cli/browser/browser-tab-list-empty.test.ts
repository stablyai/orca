import { afterEach, describe, expect, it, vi } from 'vitest'

const { callMock, runtimeClientConstructorMock, serveOrcaAppMock, getDefaultUserDataPathMock } =
  vi.hoisted(() => ({
    callMock: vi.fn(),
    runtimeClientConstructorMock: vi.fn(),
    serveOrcaAppMock: vi.fn(),
    getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data')
  }))

vi.mock('../runtime/client', async () => {
  const { createRuntimeClientModuleMock } = await import('../index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('../runtime/launch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  serveOrcaApp: serveOrcaAppMock
}))

vi.mock('../runtime/profile/metadata', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultUserDataPath: getDefaultUserDataPathMock
}))

import { main } from '../index'
import { okFixture } from '../runtime/fixtures/runtime-rpc-fixtures'

describe('orca tab list', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  // An empty one-worktree answer must not read as "no tabs anywhere" (#44981).
  it('names the worktree scope when that worktree has no tabs', async () => {
    callMock.mockResolvedValue(okFixture('req_tab_list', { tabs: [] }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'list', '--worktree', 'id:wt-b'], '/tmp/wt-a')

    expect(callMock).toHaveBeenCalledWith('browser.tabList', { worktree: 'id:wt-b' })
    expect(log).toHaveBeenCalledWith(
      'No browser tabs open in the selected worktree. Use --worktree all to list every worktree.'
    )
  })
})
