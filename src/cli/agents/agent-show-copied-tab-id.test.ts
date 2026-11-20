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

const SESSION = '0bf61e42-8693-47b2-aabd-40e22e81b930'

describe('orca agent show with a copied chat tab id', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.exitCode = undefined
  })

  it('shows the chat the copied tab holds', async () => {
    callMock.mockResolvedValue(okFixture('req_show', { agent: null, locations: [] }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['agent', 'show', '--id', `structured-agent-session-${SESSION}`, '--json'], '/tmp/w')

    expect(callMock).toHaveBeenCalledWith('agent.show', { id: SESSION })
  })
})
