import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock(
  '../../shared/remote-runtime/host-store/runtime-environment-store',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    listEnvironments: () => [{ id: 'env-1', name: 'server' }]
  })
)

import { main } from '../index'
import { okFixture } from '../runtime/fixtures/runtime-rpc-fixtures'

const browserCalls = (): string[] =>
  callMock.mock.calls.map(([method]) => String(method)).filter((m) => m.startsWith('browser.'))

// Unscoped, a paired server resolves the tab its person is looking at.
describe('browser commands over --environment', () => {
  beforeEach(() => {
    callMock.mockReset()
    callMock.mockImplementation(async (method: string) =>
      method === 'ssh.listTargetSummaries'
        ? okFixture('ssh', { targets: [] })
        : okFixture('result', { browserPageId: 'page-1' })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it.each([
    [['click', '--element', '@e1']],
    [['goto', '--url', 'https://example.com']],
    [['tab', 'current']],
    [['tab', 'create', '--url', 'https://example.com']],
    [['click', '--element', '@e1', '--worktree', 'all']]
  ])('refuses %j without --page or --worktree, sending nothing', async (args) => {
    await main([...args, '--environment', 'server', '--json'], '/tmp/not-an-orca-worktree')

    expect(browserCalls()).toEqual([])
    expect(process.exitCode).toBe(1)
  })

  it('sends a command that names its page', async () => {
    await main(
      ['click', '--element', '@e1', '--page', 'page-1', '--environment', 'server', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(browserCalls()).toEqual(['browser.click'])
    expect(process.exitCode).toBeUndefined()
  })
})

// A chat agent has no terminal workspace, so outside a workspace folder it would drive the user's tab.
describe('browser commands from a chat agent outside every workspace', () => {
  beforeEach(() => {
    callMock.mockReset()
    callMock.mockImplementation(async (method: string) =>
      method.startsWith('browser.')
        ? okFixture('result', { browserPageId: 'page-1' })
        : okFixture('result', { worktrees: [], folders: [], projects: [] })
    )
    vi.stubEnv('ORCA_STRUCTURED_SESSION', '1')
    vi.stubEnv('ORCA_WORKTREE_ID', '')
    vi.stubEnv('ORCA_WORKSPACE_ID', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it.each([
    [['goto', '--url', 'https://example.com']],
    [['tab', 'create', '--url', 'https://example.com']]
  ])('refuses %j without --page, sending nothing', async (args) => {
    await main([...args, '--json'], '/tmp/not-an-orca-worktree')

    expect(browserCalls()).toEqual([])
    expect(process.exitCode).toBe(1)
  })

  it('sends a command that names its page', async () => {
    await main(
      ['click', '--element', '@e1', '--page', 'page-1', '--json'],
      '/tmp/not-an-orca-worktree'
    )

    expect(browserCalls()).toEqual(['browser.click'])
    expect(process.exitCode).toBeUndefined()
  })
})
