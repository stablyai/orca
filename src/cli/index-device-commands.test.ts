import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('does not resolve implicit remote browser targets from client cwd', async () => {
    queueFixtures(
      callMock,
      okFixture('req_tab_current', {
        tab: {
          browserPageId: 'page-1',
          index: 0,
          url: 'https://example.com',
          title: 'Example',
          active: true,
          worktreeId: 'repo-1::/srv/orca/feature'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'current', '--pairing-code', 'remote-runtime', '--json'], '/tmp/client/src')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabCurrent', {
      worktree: undefined
    })
  })

  it('passes emulator gesture points through to the runtime', async () => {
    const points = [
      { type: 'begin', x: 0.5, y: 0.98, edge: 3 },
      { type: 'move', x: 0.5, y: 0.4, edge: 3 },
      { type: 'end', x: 0.5, y: 0.2, edge: 3 }
    ]
    queueFixtures(callMock, okFixture('req_emulator_gesture', { ok: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['emulator', 'gesture', JSON.stringify(points), '--worktree', 'id:wt-1', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('emulator.gesture', {
      points,
      device: undefined,
      emulator: undefined,
      worktree: 'id:wt-1'
    })
  })

  it('rejects emulator gesture points outside normalized coordinates', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'emulator',
        'gesture',
        JSON.stringify([
          { type: 'begin', x: 1.2, y: 0.8 },
          { type: 'end', x: 0.5, y: 0.2 }
        ]),
        '--worktree',
        'id:wt-1',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: '--points[0].x must be between 0 and 1'
      }
    })
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects emulator gesture points with invalid edge markers', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'emulator',
        'gesture',
        JSON.stringify([
          { type: 'begin', x: 0.5, y: 0.98, edge: 8 },
          { type: 'end', x: 0.5, y: 0.2, edge: 8 }
        ]),
        '--worktree',
        'id:wt-1',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'gesture point 0 edge must be an integer between 0 and 4'
      }
    })

    process.exitCode = priorExitCode
  })
})
