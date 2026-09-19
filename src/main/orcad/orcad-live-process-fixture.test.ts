import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'
import { createLiveOrcadProcess } from './orcad-live-process-fixture'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'

vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: vi.fn() }))
vi.mock('../../shared/child-process/process-tree-termination', () => ({
  forceTerminateProcessTree: vi.fn()
}))
vi.mock('../../shared/pairing', () => ({
  decodePairingOffer: () => ({ endpoint: 'http://127.0.0.1:12345' })
}))

describe('live orcad process fixture isolation', () => {
  let child: SpawnedProcess
  let kill: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    kill = vi.fn(() => true)
    child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null,
      signalCode: null,
      pid: 12345,
      kill
    }) as unknown as SpawnedProcess
    vi.mocked(spawnProcess).mockReturnValue(child as ReturnType<typeof spawnProcess>)
    vi.mocked(forceTerminateProcessTree).mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  async function startFixture(options: { mutationEnabled?: boolean } = {}) {
    const fixture = createLiveOrcadProcess(join('fixture', 'orcad.js'), 'owned-fixture', options)
    const starting = fixture.start()
    child.stdout!.emit(
      'data',
      `${JSON.stringify({ type: 'orca_server_ready', pairing: { url: 'test-offer' } })}\n`
    )
    await starting
    return fixture
  }

  it('forces background launch and mock Keychain for its private home', async () => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '0')
    vi.stubEnv('ORCA_TEST_MOCK_KEYCHAIN', '0')
    await startFixture()
    expect(vi.mocked(spawnProcess).mock.calls[0][0]).toMatchObject({
      detached: process.platform !== 'win32',
      env: {
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_TEST_MOCK_KEYCHAIN: '1',
        HOME: join('owned-fixture', 'home'),
        USERPROFILE: join('owned-fixture', 'home')
      }
    })
  })

  it('removes its shutdown listener and timer after graceful exit', async () => {
    const fixture = await startFixture()
    const listeners = child.listenerCount('exit')
    kill.mockImplementation(() => {
      child.emit('exit', 0)
      return true
    })
    await fixture.stop()
    expect(child.listenerCount('exit')).toBeLessThanOrEqual(listeners)
    expect(vi.getTimerCount()).toBe(0)
    expect(kill).toHaveBeenCalledWith('SIGTERM')
  })

  it.each([undefined, true, false])('sets the fixture mutation canary to %s', async (enabled) => {
    vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
    await startFixture({ mutationEnabled: enabled })
    expect(vi.mocked(spawnProcess).mock.calls[0][0].env).toMatchObject({
      [PTY_OWNERSHIP_TRANSFER_CANARY_ENV]: enabled === false ? '0' : '1',
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_TEST_MOCK_KEYCHAIN: '1'
    })
  })

  it.skipIf(process.platform === 'win32')(
    'cleans only its owned group after timeout and preserves diagnostics',
    async () => {
      const fixture = await startFixture()
      const listeners = child.listenerCount('exit')
      child.stderr!.emit('data', 'owned process hung')
      const stopped = expect(fixture.stop()).rejects.toThrow('owned process hung')
      await vi.advanceTimersByTimeAsync(20_000)
      await stopped
      expect(forceTerminateProcessTree).toHaveBeenCalledExactlyOnceWith(child)
      expect(child.listenerCount('exit')).toBe(listeners)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'retains both timeout and unverified cleanup errors',
    async () => {
      const fixture = await startFixture()
      vi.mocked(forceTerminateProcessTree).mockResolvedValue(false)
      const stopped = fixture.stop().catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(20_000)
      const error = await stopped
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors.map((failure: Error) => failure.message)).toEqual([
        'orcad did not exit: ',
        'fixture_orcad_process_group_cleanup_unverifiable'
      ])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'cleans its owned group when signaling throws',
    async () => {
      const fixture = await startFixture()
      const listeners = child.listenerCount('exit')
      kill.mockImplementation(() => {
        throw new Error('signal failed')
      })
      await expect(fixture.stop()).rejects.toThrow('signal failed')
      expect(forceTerminateProcessTree).toHaveBeenCalledExactlyOnceWith(child)
      expect(child.listenerCount('exit')).toBe(listeners)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
