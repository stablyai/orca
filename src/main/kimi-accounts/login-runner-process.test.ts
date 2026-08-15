import type * as NodeChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof NodeChildProcess>('node:child_process')
  return {
    ...actual,
    spawn: spawnMock
  }
})

import {
  KIMI_LOGIN_EXIT_WAIT_MS,
  KIMI_LOGIN_FORCE_KILL_WAIT_MS,
  runKimiLogin
} from './login-runner'

type FakeLoginChild = EventEmitter & {
  pid: number
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}

function createChild(): FakeLoginChild {
  const child = new EventEmitter() as FakeLoginChild
  child.pid = 4242
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  child.exitCode = null
  child.signalCode = null
  return child
}

function emitInstructions(child: FakeLoginChild): void {
  child.stdout.write('Open https://auth.kimi.com/device in your browser.\nEnter code: ABCD-EFGH\n')
}

function closeChild(child: FakeLoginChild, code: number): void {
  child.exitCode = code
  child.emit('close', code)
}

describe('runKimiLogin process lifetime', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('waits for the login child to exit before rejecting a cancel', async () => {
    const child = createChild()
    spawnMock.mockReturnValue(child)

    const pending = runKimiLogin('/managed/home', async () => 'cancel')
    emitInstructions(child)
    await Promise.resolve()
    expect(process.kill).toHaveBeenCalled()

    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    closeChild(child, 1)
    await expect(pending).rejects.toThrow(/cancelled/i)
  })

  it('force-kills a stuck login child and then rejects', async () => {
    vi.useFakeTimers()
    const child = createChild()
    spawnMock.mockReturnValue(child)

    const pending = runKimiLogin('/managed/home', async () => 'cancel')
    emitInstructions(child)
    await Promise.resolve()
    expect(process.kill).toHaveBeenCalledWith(-4242, 'SIGTERM')

    await vi.advanceTimersByTimeAsync(KIMI_LOGIN_EXIT_WAIT_MS)
    expect(process.kill).toHaveBeenCalledWith(-4242, 'SIGKILL')

    const rejected = expect(pending).rejects.toThrow(/cancelled/i)
    await vi.advanceTimersByTimeAsync(KIMI_LOGIN_FORCE_KILL_WAIT_MS)
    await rejected
  })
})
