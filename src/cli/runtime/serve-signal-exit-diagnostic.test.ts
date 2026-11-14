import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { superviseForegroundServe } from './serve-update-supervisor'

class FakeChildProcess extends EventEmitter {
  kill = vi.fn()
  pid = 5150
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function superviseChild(child: FakeChildProcess): Promise<number> {
  return superviseForegroundServe({
    spec: { program: '/Applications/Orca.app/Contents/MacOS/Orca', args: ['--serve'] },
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

describe('superviseForegroundServe signal exits', () => {
  it('treats a child exit through the caller-forwarded SIGINT as graceful', async () => {
    setPlatform('linux')
    const child = new FakeChildProcess()
    const supervised = superviseChild(child)

    process.emit('SIGINT', 'SIGINT')
    child.emit('exit', null, 'SIGINT')

    await expect(supervised).resolves.toBe(0)
  })

  it('does not terminate an exited child when update handoff completion fails late', async () => {
    vi.useFakeTimers()
    const missingParent = await mkdtemp(join(tmpdir(), 'orca-serve-missing-handoff-'))
    await rm(missingParent, { recursive: true })
    const child = new FakeChildProcess()
    const supervised = superviseForegroundServe({
      spec: { program: '/Applications/Orca.app/Contents/MacOS/Orca', args: ['--serve'] },
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
  })
})
