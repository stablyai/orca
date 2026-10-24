import * as ledger from './provider-process-ledger'
import * as processRows from './provider-process-row-read'
import * as groups from './provider-process-group'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from './provider-process-timing'
import { spawnManagedProviderProcess } from './managed-provider-process'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type { ProviderProcessTree } from './provider-process-close'

const mocks = vi.hoisted(() => ({
  capture: vi.fn(async () => null),
  windowsTree: vi.fn(async () => {})
}))
vi.mock('../pty-descendant-termination', () => ({ captureDescendantSnapshot: mocks.capture }))
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
}))
vi.mock('../windows-process-tree-kill', () => ({ terminateWindowsProcessTree: mocks.windowsTree }))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

function fakeChild(pid: number | null = 9_999_999) {
  const child = Object.assign(createFakePipedChild(), {
    pid: pid ?? undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  child.once('exit', (code, signal) => queueMicrotask(() => child.emit('close', code, signal)))
  const spawn = vi.fn<PipedProcessSpawner>(() => {
    return child
  })
  return { child, spawn }
}

function launch(fixture: ReturnType<typeof fakeChild>, platform: NodeJS.Platform = 'win32') {
  return spawnManagedProviderProcess(
    { command: 'fixture-provider', args: ['serve'], cwd: '/workspace' },
    {
      spawnImpl: fixture.spawn,
      platform,
      site: 'fixture-provider-teardown',
      acceptClose: (result) => result.root === 'exited',
      policy: () => ({ gracefulExitMs: 100, forcedExitMs: 50 })
    }
  )
}

function fakeTree(initial: DescendantTreeVerdict = 'unverifiable') {
  let verdict = initial
  const tree: ProviderProcessTree = {
    capture: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    reap: vi.fn(async () => verdict),
    get treeVerdict() {
      return verdict
    }
  }
  return {
    tree,
    setVerdict: (next: DescendantTreeVerdict) => {
      verdict = next
    }
  }
}

describe('managed provider process', () => {
  it('applies launch environment and uses the supervisor on its execution platform', () => {
    const fixture = fakeChild()
    const managed = spawnManagedProviderProcess(
      {
        command: 'fixture-provider',
        args: [],
        env: { AGENT_HOME: '/pinned' },
        envToDelete: ['SECRET']
      },
      {
        spawnImpl: fixture.spawn,
        platform: 'darwin',
        inheritedEnv: { SECRET: 'inherited', PATH: '/bin' },
        site: 'fixture',
        acceptClose: (result) => result.root === 'exited' && result.tree === 'exited',
        policy: () => ({ gracefulExitMs: PROVIDER_SUPERVISOR_MAX_STOP_MS, forcedExitMs: 50 })
      }
    )
    expect(managed.dedicatedGroup).toBe(true)
    expect(fixture.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ AGENT_HOME: '/pinned', PATH: '/bin' })
      })
    )
    expect(fixture.spawn.mock.calls[0][0].env).not.toHaveProperty('SECRET')
    expect(managed.rootVerdict).toBe('live')
  })

  it('observes exit once across exit and close, including a late subscriber', async () => {
    const fixture = fakeChild()
    const managed = launch(fixture)
    const onExit = vi.fn()
    managed.onExit(onExit)
    fixture.child.emit('exit', 7, 'SIGTERM')
    fixture.child.emit('close', 7, 'SIGTERM')
    fixture.child.emit('exit', 8, 'SIGKILL')
    await managed.exitPromise
    expect(onExit).toHaveBeenCalledExactlyOnceWith({
      code: 7,
      signal: 'SIGTERM',
      processless: false
    })
    const late = vi.fn()
    managed.onExit(late)
    expect(late).toHaveBeenCalledExactlyOnceWith({ code: 7, signal: 'SIGTERM', processless: false })
    await expect(managed.close()).resolves.toMatchObject({ root: 'exited' })
    expect(fixture.child.kill).not.toHaveBeenCalled()
  })

  it('proves stdin-close exit without forcing and clears the grace timer', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = launch(fixture)
    fixture.child.stdin.once('finish', () => fixture.child.emit('exit', 0, null))
    const closing = managed.close()
    expect(fixture.child.stdin.writableEnded).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    await expect(closing).resolves.toMatchObject({ root: 'exited' })
    expect(fixture.child.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

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

  it('still reports a root exit once after an unconfirmed close', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = launch(fixture)
    const report = vi.fn()
    managed.onExit(report)
    const close = managed.close()
    await vi.advanceTimersByTimeAsync(150)
    await expect(close).resolves.toMatchObject({ root: 'live' })
    fixture.child.emit('exit', 0, null)
    fixture.child.emit('close', 0, null)
    expect(report).toHaveBeenCalledOnce()
    await expect(managed.close()).resolves.toMatchObject({ root: 'exited' })
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

  it('names a missing provider executable from a direct spawn error or a supervisor report', async () => {
    const direct = fakeChild(null)
    const directManaged = launch(direct)
    direct.child.emit(
      'error',
      Object.assign(new Error('spawn fixture-provider ENOENT'), {
        code: 'ENOENT',
        path: 'fixture-provider'
      })
    )
    expect(directManaged.executableMissing).toBe(true)
  })

  it('does not turn a transport close with an existing pid into Claude exit proof', () => {
    const fixture = fakeChild()
    const managed = launch(fixture)
    fixture.child.emit('error', new Error('EPIPE'))
    fixture.child.emit('close', 0, null)
    expect(managed.rootVerdict).toBe('live')
    expect(managed.processless).toBe(false)
  })

  it('uses Windows tree teardown and still requires observed root exit', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = launch(fixture, 'win32')
    expect(managed.dedicatedGroup).toBe(false)
    const first = managed.close()
    await vi.advanceTimersByTimeAsync(150)
    await expect(first).resolves.toMatchObject({ root: 'live' })
    expect(mocks.windowsTree).toHaveBeenCalledWith(fixture.child.pid, {
      site: 'fixture-provider-teardown'
    })
    expect(fixture.child.kill).not.toHaveBeenCalledWith('SIGTERM')
    fixture.child.emit('exit', null, 'SIGKILL')
    await expect(managed.close()).resolves.toMatchObject({ root: 'exited' })
  })

  it('preserves a caller requiring tree proof, including live and unverifiable descendants', async () => {
    const fixture = fakeChild()
    const managed = spawnManagedProviderProcess(
      { command: 'fixture-provider', args: [] },
      {
        spawnImpl: fixture.spawn,
        platform: 'darwin',
        site: 'fixture',
        acceptClose: (result) => result.root === 'exited' && result.tree === 'exited',
        policy: () => ({ gracefulExitMs: PROVIDER_SUPERVISOR_MAX_STOP_MS, forcedExitMs: 50 })
      }
    )
    const proof = fakeTree()
    fixture.child.emit('exit', 0, null)
    await expect(managed.close(proof.tree)).resolves.toEqual({
      root: 'exited',
      tree: 'unverifiable'
    })
    proof.setVerdict('live')
    await expect(managed.close(proof.tree)).resolves.toEqual({ root: 'exited', tree: 'live' })
    proof.setVerdict('exited')
    await expect(managed.close(proof.tree)).resolves.toEqual({ root: 'exited', tree: 'exited' })
    await expect(managed.close(proof.tree)).resolves.toEqual({ root: 'exited', tree: 'exited' })
    expect(proof.tree.capture).not.toHaveBeenCalled()
  })

  it('reports failed tree cleanup separately after observed root exit', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = launch(fixture, 'win32')
    mocks.windowsTree.mockImplementationOnce(async () => {
      fixture.child.emit('exit', null, 'SIGKILL')
      throw new Error('tree teardown unavailable')
    })
    const close = managed.close()
    await vi.advanceTimersByTimeAsync(150)
    await expect(close).resolves.toMatchObject({ root: 'exited' })
    expect(managed.lastCloseResult).toEqual({ root: 'exited', tree: 'unverifiable' })
  })

  it('keeps the cleanup diagnostic tied to the close that finished before a late root exit', async () => {
    vi.useFakeTimers()
    const fixture = fakeChild()
    const managed = launch(fixture, 'win32')
    mocks.windowsTree.mockRejectedValueOnce(new Error('tree teardown unavailable'))
    const close = managed.close()
    await vi.advanceTimersByTimeAsync(150)
    await expect(close).resolves.toMatchObject({ root: 'live' })
    fixture.child.emit('exit', null, 'SIGKILL')
    await expect(managed.close()).resolves.toMatchObject({ root: 'exited' })
    expect(managed.lastCloseResult).toEqual({ root: 'live', tree: 'unverifiable' })
  })
})

function recordMembers(members: { pid: number; pgid: number; startedAt: string }[]): void {
  vi.spyOn(ledger, 'recordProviderLaunch').mockReturnValue({
    capture: async () => {},
    retire: async () => {},
    members: () => members
  })
}

it('joins natural cleanup after an earlier unproven close before publishing completion', async () => {
  vi.useFakeTimers()
  const fixture = fakeChild()
  recordMembers([])
  vi.spyOn(groups, 'signalProviderGroup').mockImplementation(() => {})
  vi.spyOn(groups, 'stopRecordedProviderGroup').mockResolvedValue('unverifiable')
  const natural = Promise.withResolvers<DescendantTreeVerdict>()
  vi.spyOn(groups, 'observeProviderGroup').mockReturnValue(natural.promise)
  const managed = launch(fixture, 'darwin')
  const close = managed.close()
  await vi.advanceTimersByTimeAsync(2_000)
  await expect(close).resolves.toMatchObject({ root: 'live', tree: 'unverifiable' })
  const publish = vi.fn()
  managed.onSettled(publish)
  fixture.child.emit('exit', 0, null)
  await vi.advanceTimersByTimeAsync(0)
  expect(publish).not.toHaveBeenCalled()
  natural.resolve('unverifiable')
  await managed.completion
  expect(publish).toHaveBeenCalledOnce()
  expect(managed.lastCloseResult).toEqual({ root: 'exited', tree: 'unverifiable' })
  vi.mocked(groups.stopRecordedProviderGroup).mockResolvedValueOnce('exited')
  await expect(managed.close()).resolves.toEqual({ root: 'exited', tree: 'exited' })
  expect(groups.signalProviderGroup).toHaveBeenCalledTimes(1)
})

it('joins a tree attached while final output drains before publishing completion', async () => {
  vi.useFakeTimers()
  const fixture = fakeChild()
  fixture.child.removeAllListeners('exit')
  recordMembers([])
  vi.spyOn(groups, 'signalProviderGroup').mockImplementation(() => {})
  vi.spyOn(groups, 'observeProviderGroup').mockResolvedValue('exited')
  const managed = launch(fixture, 'darwin')
  fixture.child.emit('exit', 0, null)
  await vi.advanceTimersByTimeAsync(0)
  const cleanup = Promise.withResolvers<DescendantTreeVerdict>()
  const { tree } = fakeTree()
  vi.mocked(tree.reap).mockReturnValue(cleanup.promise)
  managed.attachTree(tree)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(tree.reap).toHaveBeenCalledOnce()
  expect(managed.settled).toBe(false)
  cleanup.resolve('exited')
  await managed.completion
  expect(managed.settled).toBe(true)
})

// libuv queues several waitpid results before delivering callbacks; this drives the real close path.
it('retries qualified cleanup when another pending exit callback starts close before root notification', async () => {
  vi.useFakeTimers()
  const first = fakeChild(9_999_998)
  const fixture = fakeChild()
  const pid = fixture.child.pid!
  const members = [{ pid, pgid: pid, startedAt: 'original' }]
  recordMembers(members)
  let current = 'reused'
  let absent = false
  vi.spyOn(processRows, 'readPosixProcessRow').mockImplementation(async () => ({
    pid,
    pgid: pid,
    ppid: process.pid,
    startedAt: current,
    startResolution: 'clock-tick'
  }))
  const signals: string[] = []
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (absent) {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    }
    if (typeof signal === 'string') {
      signals.push(signal)
    }
    if (signal === 'SIGKILL') {
      absent = true
    }
    return true
  })
  const managed = launch(fixture, 'darwin')
  let pending: Promise<unknown> | undefined
  first.child.once('exit', () => {
    pending = managed.close()
  })
  // Both kernel exits are pending; the earlier callback runs while this root has a different incarnation.
  first.child.emit('exit', 0, null)
  await vi.advanceTimersByTimeAsync(2_000)
  await expect(pending).resolves.toMatchObject({ tree: 'unverifiable' })
  expect(signals).toEqual([])
  current = 'original'
  const retry = Promise.all([managed.close(), managed.close()])
  await vi.advanceTimersByTimeAsync(5_000)
  await retry
  expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  fixture.child.emit('exit', 0, null)
  await vi.advanceTimersByTimeAsync(1_000)
  await managed.completion
  await managed.close()
  expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
})
