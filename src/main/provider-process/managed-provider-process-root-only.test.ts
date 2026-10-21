import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { ROOT_ONLY_GRACEFUL_EXIT_MS } from './provider-process-close'
import type { ProviderProcessTeardownVerdict } from './provider-process-teardown'

const teardown = vi.hoisted(() => ({
  terminate: vi.fn(async (): Promise<ProviderProcessTeardownVerdict> => 'exited')
}))
vi.mock('./provider-process-teardown', () => ({
  terminateProviderProcessTree: teardown.terminate
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

/** A provider with no reaper of its own takes every close default. */
function rootOnly(fixture: ReturnType<typeof fakeChild>) {
  return spawnManagedProviderProcess(
    { command: 'fixture-provider', args: [] },
    { spawnImpl: fixture.spawn, platform: 'win32', site: 'fixture-provider-teardown' }
  )
}

describe('root-only managed provider close', () => {
  it('reports no descendant observation when the root leaves on stdin end', async () => {
    const fixture = fakeChild()
    fixture.child.stdin.once('finish', () => fixture.child.emit('exit', 0, null))
    const managed = rootOnly(fixture)
    await expect(managed.close()).resolves.toEqual({ root: 'exited', tree: null })
    expect(teardown.terminate).not.toHaveBeenCalled()
  })

  it.each(['exited', 'live', 'unverifiable', null] as const)(
    'writes what the fallback teardown observed (%s) as the tree verdict',
    async (tree) => {
      vi.useFakeTimers()
      teardown.terminate.mockImplementationOnce(async () => {
        fixture.child.emit('exit', null, 'SIGKILL')
        return tree
      })
      const fixture = fakeChild()
      const managed = rootOnly(fixture)
      const closing = managed.close()
      await vi.advanceTimersByTimeAsync(ROOT_ONLY_GRACEFUL_EXIT_MS)
      await expect(closing).resolves.toEqual({ root: 'exited', tree })
      // The root is gone, so the close is done: a repeat answers from the memo, not a second teardown.
      await expect(managed.close()).resolves.toEqual({ root: 'exited', tree })
      expect(teardown.terminate).toHaveBeenCalledOnce()
      expect(managed.lastCloseResult).toEqual({ root: 'exited', tree })
    }
  )

  it('waits the default root-only grace before forcing', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = rootOnly(fixture)
    void managed.close()
    await vi.advanceTimersByTimeAsync(ROOT_ONLY_GRACEFUL_EXIT_MS - 1)
    expect(teardown.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(teardown.terminate).toHaveBeenCalledOnce()
  })

  it('records the already-exited answer when no close ran, without touching the child', async () => {
    const fixture = fakeChild()
    const managed = rootOnly(fixture)
    fixture.child.emit('exit', 0, null)
    await expect(managed.close()).resolves.toEqual({ root: 'exited', tree: null })
    expect(managed.lastCloseResult).toEqual({ root: 'exited', tree: null })
    expect(fixture.child.stdin.writableEnded).toBe(false)
    expect(fixture.child.kill).not.toHaveBeenCalled()
  })

  it('drains stderr into a bounded tail', async () => {
    const fixture = fakeChild()
    const managed = rootOnly(fixture)
    fixture.child.stderr.write('x'.repeat(9000))
    fixture.child.stderr.write('provider: not signed in')
    await new Promise((resolve) => setImmediate(resolve))
    expect(managed.stderrTail()).toMatch(/provider: not signed in$/)
    expect(managed.stderrTail()).toHaveLength(8192)
  })
})

describe('root exit observation', () => {
  it('never reads a failed spawn as an observed root exit', () => {
    const fixture = fakeChild(null)
    const managed = rootOnly(fixture)
    fixture.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    fixture.child.emit('close', -2, null)
    expect(managed.rootVerdict).toBe('exited')
    expect(managed.processless).toBe(true)
    expect(managed.rootExitObserved).toBe(false)
  })

  it('reads a real process exit as observed', () => {
    const fixture = fakeChild()
    const managed = rootOnly(fixture)
    expect(managed.rootExitObserved).toBe(false)
    fixture.child.emit('exit', 1, null)
    expect(managed.rootExitObserved).toBe(true)
  })
})
