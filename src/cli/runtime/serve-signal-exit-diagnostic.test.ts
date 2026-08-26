import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serveSignalExitError } from './serve-signal-exit-diagnostic'
import {
  SERVE_CHILD_FORCE_KILL_GRACE_MS,
  SERVE_CHILD_FORCE_KILL_SCHEDULING_MARGIN_MS,
  superviseForegroundServe
} from './serve-update-supervisor'
import { RuntimeClientError } from './types'
import {
  QUIT_RENDERER_ACK_TIMEOUT_MS,
  WILL_QUIT_TEARDOWN_DEADLINE_MS
} from '../../shared/quit-teardown-deadline'

class FakeChildProcess extends EventEmitter {
  kill = vi.fn()
  pid = 5150
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function superviseUntilExit(code: number | null, signal: NodeJS.Signals | null): Promise<number> {
  const child = new FakeChildProcess()
  const supervised = superviseChild(child)
  child.emit('exit', code, signal)
  return supervised
}

function superviseChild(child: FakeChildProcess): Promise<number> {
  return superviseForegroundServe({
    executable: '/Applications/Orca.app/Contents/MacOS/Orca',
    childArgs: ['--serve'],
    spawnOptions: {},
    spawnChild: vi.fn() as never,
    handoffPath: null,
    child: child as never,
    expectedHandoff: null
  })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('serveSignalExitError', () => {
  it('explains the macOS window-server abort on darwin SIGABRT', () => {
    const error = serveSignalExitError('SIGABRT', 'darwin')

    expect(error).toBeInstanceOf(RuntimeClientError)
    expect(error.code).toBe('runtime_serve_failed')
    expect(error.message).toContain('aborted with SIGABRT on macOS')
    expect(error.message).toContain('macOS window server')
    expect(error.data).toMatchObject({
      nextSteps: [
        expect.stringContaining('macOS desktop login'),
        expect.stringContaining('~/Library/Logs/DiagnosticReports/Orca-*.ips')
      ]
    })
  })

  it('does not claim the macOS cause off darwin', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const error = serveSignalExitError('SIGABRT', platform)

      expect(error.message).toBe('Orca serve exited via SIGABRT.')
      expect(error.data).toBeUndefined()
    }
  })

  it('does not claim the macOS cause for other darwin signals', () => {
    const error = serveSignalExitError('SIGKILL', 'darwin')

    expect(error.message).toBe('Orca serve exited via SIGKILL.')
    expect(error.data).toBeUndefined()
  })

  it('stays clear when neither a code nor a signal is reported', () => {
    expect(serveSignalExitError(null, 'darwin').message).toBe(
      'Orca serve exited without reporting an exit code or signal.'
    )
  })
})

describe('superviseForegroundServe signal exits', () => {
  it('lets pre-commit and committed Electron quit deadlines finish before force-killing serve', async () => {
    setPlatform('linux')
    vi.useFakeTimers()
    const child = new FakeChildProcess()
    const supervised = superviseChild(child)

    expect(SERVE_CHILD_FORCE_KILL_GRACE_MS).toBe(
      QUIT_RENDERER_ACK_TIMEOUT_MS +
        WILL_QUIT_TEARDOWN_DEADLINE_MS +
        SERVE_CHILD_FORCE_KILL_SCHEDULING_MARGIN_MS
    )
    expect(SERVE_CHILD_FORCE_KILL_GRACE_MS).toBeLessThanOrEqual(35_000)

    process.emit('SIGTERM', 'SIGTERM')
    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenLastCalledWith('SIGTERM')

    await vi.advanceTimersByTimeAsync(QUIT_RENDERER_ACK_TIMEOUT_MS + WILL_QUIT_TEARDOWN_DEADLINE_MS)
    expect(child.kill).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(SERVE_CHILD_FORCE_KILL_SCHEDULING_MARGIN_MS)
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(child.kill).toHaveBeenCalledTimes(2)

    child.emit('exit', null, 'SIGKILL')
    await expect(supervised).rejects.toThrow('Orca serve exited via SIGKILL.')
  })

  it('lets a shared-console Windows child handle Ctrl-C gracefully', async () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const child = new FakeChildProcess()
    const supervised = superviseChild(child)

    process.emit('SIGINT', 'SIGINT')
    expect(child.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    child.emit('exit', 0, null)
    await expect(supervised).resolves.toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not terminate an exited child when update handoff completion fails late', async () => {
    vi.useFakeTimers()
    const missingParent = await mkdtemp(join(tmpdir(), 'orca-serve-missing-handoff-'))
    await rm(missingParent, { recursive: true })
    const child = new FakeChildProcess()
    const supervised = superviseForegroundServe({
      executable: '/Applications/Orca.app/Contents/MacOS/Orca',
      childArgs: ['--serve'],
      spawnOptions: {},
      spawnChild: vi.fn() as never,
      handoffPath: join(missingParent, 'handoff.json'),
      child: child as never,
      expectedHandoff: {
        schemaVersion: 1,
        phase: 'install-requested',
        fromVersion: '1.0.51',
        targetVersion: '1.0.61',
        servingPid: child.pid
      }
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    child.emit('message', {
      type: 'orca:serve-ready',
      version: '1.0.61',
      runtimeId: 'runtime-new'
    })
    child.emit('exit', 0, null)

    await expect(supervised).resolves.toBe(1)
    expect(child.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('throws the macOS diagnostic when the child aborts on darwin', async () => {
    setPlatform('darwin')

    await expect(superviseUntilExit(null, 'SIGABRT')).rejects.toThrow(
      /aborted with SIGABRT on macOS/
    )
  })

  it('reports the plain signal on linux', async () => {
    setPlatform('linux')

    await expect(superviseUntilExit(null, 'SIGABRT')).rejects.toThrow(
      'Orca serve exited via SIGABRT.'
    )
  })

  it('returns numeric exit codes unchanged', async () => {
    setPlatform('darwin')

    await expect(superviseUntilExit(0, null)).resolves.toBe(0)
    await expect(superviseUntilExit(7, null)).resolves.toBe(7)
  })
})
