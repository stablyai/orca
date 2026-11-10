import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from './provider-process-supervisor'
import { spawnManagedProviderProcess } from './managed-provider-process'

const mocks = vi.hoisted(() => ({
  capture: vi.fn(async () => null),
  windowsTree: vi.fn(async () => {})
}))
vi.mock('../pty/process-retirement/pty-descendant-termination', () => ({
  captureDescendantSnapshot: mocks.capture
}))
vi.mock('../pty/process-retirement/windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: mocks.windowsTree
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function fakeChild(pid: number | null = 9_999_999) {
  const child = Object.assign(createFakePipedChild(), {
    pid: pid ?? undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  const spawn = vi.fn<PipedProcessSpawner>(() => {
    return child
  })
  return { child, spawn }
}

function launch(fixture: ReturnType<typeof fakeChild>, platform: NodeJS.Platform = 'win32') {
  return spawnManagedProviderProcess(
    { command: 'fixture-provider', args: ['serve'], cwd: tmpdir() },
    {
      spawnImpl: fixture.spawn,
      platform,
      site: 'fixture-provider-teardown',
      acceptClose: (result) => result.root === 'exited',
      policy: () => ({ gracefulExitMs: 100, forcedExitMs: 50 })
    }
  )
}

describe('managed provider process', () => {
  it('joins a close, keeps root live after the kill deadline, and retries on the same child', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = launch(fixture)
    const first = managed.close()
    expect(managed.close()).toBe(first)
    await vi.advanceTimersByTimeAsync(150)
    await expect(first).resolves.toMatchObject({ root: 'live' })
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(managed.rootVerdict).toBe('live')
    fixture.child.kill.mockImplementation(() => {
      fixture.child.emit('exit', null, 'SIGKILL')
      return true
    })
    const second = managed.close()
    await vi.advanceTimersByTimeAsync(150)
    await expect(second).resolves.toMatchObject({ root: 'exited' })
    expect(fixture.spawn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('requires error then close for a processless spawn to settle', async () => {
    const fixture = fakeChild(null)
    const managed = launch(fixture)
    expect(managed.rootVerdict).toBe('unverifiable')
    fixture.child.emit('close', -2, null)
    expect(managed.rootVerdict).toBe('unverifiable')
    fixture.child.emit('error', new Error('ENOENT'))
    expect(managed.rootVerdict).toBe('unverifiable')
    fixture.child.emit('close', null, null)
    expect(managed.processless).toBe(true)
    expect(managed.rootVerdict).toBe('exited')
    await expect(managed.close()).resolves.toMatchObject({ root: 'exited' })
  })

  // Direct (Windows) and supervised (POSIX) spawns: Node names what it spawned, never the folder.
  it.each(['win32', 'linux'] as const)(
    'names a deleted working folder, not the CLI, when a real %s spawn fails there',
    async (platform) => {
      const parent = mkdtempSync(join(tmpdir(), 'orca-provider-cwd-'))
      try {
        // Found on PATH, so only the missing folder can fail the spawn.
        const managed = spawnManagedProviderProcess(
          { command: basename(process.execPath), args: ['-e', ''], cwd: join(parent, 'deleted') },
          {
            platform,
            policy: () => ({ gracefulExitMs: PROVIDER_SUPERVISOR_MAX_STOP_MS, forcedExitMs: 50 }),
            inheritedEnv: { PATH: dirname(process.execPath) },
            site: 'fixture-provider-missing-cwd'
          }
        )
        await managed.exitPromise
        expect(managed.executableMissing).toBe(false)
        expect(managed.spawnAbsence).toBe('launchFolder')
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    }
  )

  it('does not turn a transport close with an existing pid into Claude exit proof', () => {
    const fixture = fakeChild()
    const managed = launch(fixture)
    fixture.child.emit('error', new Error('EPIPE'))
    fixture.child.emit('close', 0, null)
    expect(managed.rootVerdict).toBe('live')
    expect(managed.processless).toBe(false)
  })
})
