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

const TAB_ID = 'c6def874-6e3b-4f21-91da-9acf6759f976'
const PAGE_ID = 'd29722cd-5834-4dd1-9027-2b449a216260'

describe('orca tab show with a copied tab id', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.exitCode = undefined
  })

  it('shows the page the copied browser tab holds', async () => {
    callMock.mockImplementation(async (method: string) =>
      method === 'browser.tabList'
        ? okFixture('req_tabs', {
            tabs: [
              {
                browserPageId: PAGE_ID,
                unifiedTabId: TAB_ID,
                index: 0,
                url: 'https://www.google.com/',
                title: 'Google',
                active: true
              }
            ]
          })
        : okFixture('req_show', {
            tab: {
              browserPageId: PAGE_ID,
              index: 0,
              url: 'https://www.google.com/',
              title: 'Google',
              active: true
            }
          })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'show', '--page', TAB_ID, '--json'], '/tmp/w')

    expect(callMock).toHaveBeenCalledWith('browser.tabShow', { page: PAGE_ID })
  })
})
