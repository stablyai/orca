import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readServeSupervisorBrake } from './serve-supervisor-brake'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }))

import { serveOrcaApp } from './launch'

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough()
  kill = vi.fn()
  pid = 5100
}

describe('serveOrcaApp --supervise', () => {
  let root: string

  beforeEach(async () => {
    spawnMock.mockReset()
    root = await mkdtemp(join(tmpdir(), 'orca-serve-supervise-'))
    const executable = join(root, 'orca')
    await writeFile(executable, '')
    process.env.ORCA_APP_EXECUTABLE = executable
    process.env.ORCA_SERVE_RUNTIME = 'electron'
    process.env.ORCA_USER_DATA_PATH = join(root, 'profile')
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    delete process.env.ORCA_APP_EXECUTABLE
    delete process.env.ORCA_SERVE_RUNTIME
    delete process.env.ORCA_USER_DATA_PATH
    await rm(root, { recursive: true, force: true })
  })

  it('restarts a child that died instead of exiting, and stops on SIGTERM', async () => {
    const children = [new FakeChildProcess(), new FakeChildProcess()]
    spawnMock.mockImplementation(() => {
      const child = children[spawnMock.mock.calls.length - 1]
      if (spawnMock.mock.calls.length === 1) {
        queueMicrotask(() => child.emit('exit', 1, null))
      } else {
        child.kill.mockImplementation((signal: NodeJS.Signals) =>
          queueMicrotask(() => child.emit('exit', null, signal))
        )
        queueMicrotask(() => process.emit('SIGTERM', 'SIGTERM'))
      }
      return child
    })

    await expect(serveOrcaApp({ supervise: true })).resolves.toBe(0)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(children[1].kill).toHaveBeenCalledWith('SIGTERM')
    expect(readServeSupervisorBrake(join(root, 'profile'))?.failures).toHaveLength(1)
    expect(process.listenerCount('SIGTERM')).toBe(0)
  }, 10_000)

  it('starts the server from the app, not the copy, once relocated outside it', async () => {
    const appRoot = join(root, 'Orca.app', 'Contents', 'Resources', 'app.asar.unpacked')
    process.env.ORCA_SERVE_SUPERVISOR_APP_ROOT = appRoot
    try {
      const child = new FakeChildProcess()
      child.kill.mockImplementation((signal: NodeJS.Signals) =>
        queueMicrotask(() => child.emit('exit', null, signal))
      )
      spawnMock.mockImplementation(() => {
        queueMicrotask(() => process.emit('SIGTERM', 'SIGTERM'))
        return child
      })
      await expect(serveOrcaApp({ supervise: true })).resolves.toBe(0)
      expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: appRoot })
      expect(spawnMock.mock.calls[0][2].env).not.toHaveProperty('ORCA_SERVE_SUPERVISOR_APP_ROOT')
    } finally {
      delete process.env.ORCA_SERVE_SUPERVISOR_APP_ROOT
    }
  })

  it('does not start again when stopped during the restart delay', async () => {
    const child = new FakeChildProcess()
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit('exit', 1, null)
        setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 50)
      })
      return child
    })
    await expect(serveOrcaApp({ supervise: true })).resolves.toBe(0)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('passes a stop that arrived before the child existed on to that child', async () => {
    const child = new FakeChildProcess()
    child.kill.mockImplementation((signal: NodeJS.Signals) =>
      queueMicrotask(() => child.emit('exit', null, signal))
    )
    spawnMock.mockImplementation(() => {
      process.emit('SIGTERM', 'SIGTERM')
      return child
    })
    await expect(serveOrcaApp({ supervise: true })).resolves.toBe(0)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('keeps today’s exit-on-child-exit without --supervise', async () => {
    const child = new FakeChildProcess()
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 1, null))
      return child
    })
    await expect(serveOrcaApp({})).resolves.toBe(1)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})
