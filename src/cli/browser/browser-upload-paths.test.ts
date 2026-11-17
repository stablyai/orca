import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('orca upload', () => {
  beforeEach(() => {
    callMock.mockReset()
    callMock.mockImplementation(async () => okFixture('req_upload', { uploaded: 2 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('resolves relative files against the caller cwd, not the runtime cwd', async () => {
    const windows = process.platform === 'win32'
    await main(
      ['upload', '--element', '#f', '--files', './a.png, ../b.png', '--page', 'page-1'],
      windows ? 'C:\\work\\repo\\sub' : '/work/repo/sub'
    )

    expect(callMock).toHaveBeenCalledWith(
      'browser.upload',
      expect.objectContaining({
        files: windows
          ? ['C:\\work\\repo\\sub\\a.png', 'C:\\work\\repo\\b.png']
          : ['/work/repo/sub/a.png', '/work/repo/b.png']
      })
    )
  })
})
