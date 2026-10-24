import './mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'
import { getHistorySessionDirName } from './history-paths'
import type { SubprocessHandle } from './session-subprocess-handle'

let harness: DaemonAdapterHarness | undefined
let adapter: DaemonPtyAdapter | undefined
let subprocess: SubprocessHandle & { _simulateExit(code: number): void }

async function start(withHistory = true): Promise<DaemonPtyAdapter> {
  harness = await startDaemonAdapterHarness(() => {
    subprocess = createMockSubprocess()
    return subprocess
  })
  harness.adapter.dispose()
  adapter = new DaemonPtyAdapter({
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    ...(withHistory ? { historyPath: join(harness.dir, 'history') } : {})
  })
  return adapter
}

function historyTree(id: string): string {
  return join(harness!.dir, 'history', getHistorySessionDirName(id))
}

function checkedRequest(id: string, expectedIncarnationId: string) {
  return { id, expectedIncarnationId, requireNoAgentOwner: false, requireUnattached: false }
}

async function spawn(provider: DaemonPtyAdapter, id = 'checked-close') {
  const result = await provider.spawn({ sessionId: id, cols: 80, rows: 24 })
  if (!result.incarnationId) {
    throw new Error('Expected incarnation')
  }
  return { ...result, incarnationId: result.incarnationId }
}

afterEach(async () => {
  adapter?.dispose()
  await harness?.server.shutdown()
  if (harness) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
  adapter = undefined
  harness = undefined
  vi.restoreAllMocks()
})

describe('DaemonPtyAdapter checked explicit close', () => {
  it.each(['ended', 'already_exited'] as const)(
    'removes the real history tree after %s without another kill',
    async (outcome) => {
      const provider = await start()
      const created = await spawn(provider)
      const tree = historyTree(created.id)
      expect(existsSync(join(tree, 'meta.json'))).toBe(true)
      if (outcome === 'already_exited') {
        subprocess._simulateExit(0)
        await waitFor(() => !provider.hasPty(created.id))
        expect(provider.getHistoryManager()!.readMeta(created.id)?.endedAt).toBeTruthy()
      }
      const request = vi.spyOn(provider['client'], 'request')

      await expect(
        provider.killFenced(checkedRequest(created.id, created.incarnationId))
      ).resolves.toEqual({ outcome })

      expect(existsSync(tree)).toBe(false)
      expect(provider.getHistoryManager()!.hasWriter(created.id)).toBe(false)
      expect(provider.hasPty(created.id)).toBe(false)
      const kills = request.mock.calls.filter(([type]) => type === 'kill')
      expect(kills).toHaveLength(1)
      expect(kills[0]?.[1]).toMatchObject({
        sessionId: created.id,
        expectedIncarnationId: created.incarnationId,
        immediate: true
      })
      await expect(spawn(provider, created.id)).rejects.toThrow('was explicitly killed')
    }
  )

  it('retains history and the live session on a checked refusal', async () => {
    const provider = await start()
    const created = await spawn(provider)
    const tree = historyTree(created.id)
    const meta = readFileSync(join(tree, 'meta.json'), 'utf8')

    await expect(
      provider.killFenced(checkedRequest(created.id, 'predecessor-incarnation'))
    ).resolves.toEqual({ outcome: 'refused', reason: 'replaced' })

    expect(readFileSync(join(tree, 'meta.json'), 'utf8')).toBe(meta)
    expect(provider.getHistoryManager()!.hasWriter(created.id)).toBe(true)
    expect(provider.hasPty(created.id)).toBe(true)
    expect(subprocess.forceKill).not.toHaveBeenCalled()
  })

  it.each([
    ['connection loss', undefined],
    ['missing checked outcome', undefined],
    ['bare acknowledgment', {}],
    ['unknown outcome', { outcome: 'ok' }],
    ['unknown refusal', { outcome: 'refused', reason: 'new_reason' }]
  ])('retains history when completion is unverifiable due to %s', async (failure, reply) => {
    const provider = await start()
    const created = await spawn(provider)
    const tree = historyTree(created.id)
    const originalRequest = provider['client'].request.bind(provider['client'])
    const request = vi.spyOn(provider['client'], 'request').mockImplementation((type, payload) => {
      if (type === 'kill') {
        return failure === 'connection loss'
          ? Promise.reject(new Error('control connection lost'))
          : Promise.resolve(reply)
      }
      return originalRequest(type, payload)
    })

    await expect(
      provider.killFenced(checkedRequest(created.id, created.incarnationId))
    ).resolves.toEqual({ outcome: 'refused', reason: 'unverifiable' })

    expect(existsSync(join(tree, 'meta.json'))).toBe(true)
    expect(provider.getHistoryManager()!.hasWriter(created.id)).toBe(true)
    expect(provider.hasPty(created.id)).toBe(true)
    expect(request.mock.calls.filter(([type]) => type === 'kill')).toHaveLength(1)
  })

  it('retains replacement state published while a history-free checked reply is pending', async () => {
    const provider = await start(false)
    const created = await spawn(provider)
    const originalRequest = provider['client'].request.bind(provider['client'])
    let replyHeld = false
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const request = vi
      .spyOn(provider['client'], 'request')
      .mockImplementation(async (type, payload) => {
        const result = await originalRequest(type, payload)
        if (type === 'kill') {
          replyHeld = true
          await held
        }
        return result
      })
    const closing = provider.killFenced(checkedRequest(created.id, created.incarnationId))
    await waitFor(() => replyHeld)
    const replacement = await spawn(provider, created.id)
    expect(replacement.incarnationId).not.toBe(created.incarnationId)
    release()

    await expect(closing).resolves.toEqual({ outcome: 'ended' })
    expect(provider.hasPty(created.id)).toBe(true)
    expect((await spawn(provider, created.id)).incarnationId).toBe(replacement.incarnationId)
    expect(request.mock.calls.filter(([type]) => type === 'kill')).toHaveLength(1)
  })

  it('keeps replacement history published while an old checked End waits for the lifecycle lock', async () => {
    const provider = await start()
    const predecessor = await spawn(provider)
    subprocess._simulateExit(0)
    await waitFor(() => !provider.hasPty(predecessor.id))
    const manager = provider.getHistoryManager()!
    const originalOpen = manager.openSession.bind(manager)
    let opening = false
    let releaseOpen!: () => void
    const heldOpen = new Promise<void>((resolve) => (releaseOpen = resolve))
    vi.spyOn(manager, 'openSession').mockImplementation(async (id, opts) => {
      opening = true
      await heldOpen
      await originalOpen(id, opts)
    })
    const replacing = spawn(provider, predecessor.id)
    await waitFor(() => opening)
    const originalRequest = provider['client'].request.bind(provider['client'])
    let replyHeld = false
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const request = vi
      .spyOn(provider['client'], 'request')
      .mockImplementation(async (type, payload) => {
        if (type === 'kill') {
          replyHeld = true
          await held
          // The daemon may have completed the predecessor kill before this replacement was adopted.
          return { outcome: 'already_exited' }
        }
        return originalRequest(type, payload)
      })
    const closing = provider.killFenced(checkedRequest(predecessor.id, predecessor.incarnationId))
    releaseOpen()
    const replacement = await replacing
    const tree = historyTree(replacement.id)
    const meta = readFileSync(join(tree, 'meta.json'), 'utf8')
    await waitFor(() => replyHeld)
    release()

    await expect(closing).resolves.toEqual({ outcome: 'already_exited' })
    expect(readFileSync(join(tree, 'meta.json'), 'utf8')).toBe(meta)
    expect(provider.getHistoryManager()!.hasWriter(replacement.id)).toBe(true)
    expect(provider.hasPty(replacement.id)).toBe(true)
    expect((await spawn(provider, replacement.id)).incarnationId).toBe(replacement.incarnationId)
    expect(request.mock.calls.filter(([type]) => type === 'kill')).toHaveLength(1)
  })

  it('holds the lifecycle lock through checked history removal', async () => {
    const provider = await start()
    const created = await spawn(provider)
    const manager = provider.getHistoryManager()!
    const originalRemove = manager.removeSession.bind(manager)
    let removing = false
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(manager, 'removeSession').mockImplementation(async (id) => {
      removing = true
      await held
      await originalRemove(id)
    })
    const closing = provider.killFenced(checkedRequest(created.id, created.incarnationId))
    await waitFor(() => removing)
    const reopening = provider.spawn({ sessionId: created.id, cols: 80, rows: 24 })
    // Handle rejection before releasing the lock to avoid an unhandled promise rejection.
    const reopened = expect(reopening).rejects.toThrow('was explicitly killed')
    expect(existsSync(historyTree(created.id))).toBe(true)
    release()

    await expect(closing).resolves.toEqual({ outcome: 'ended' })
    await reopened
    expect(existsSync(historyTree(created.id))).toBe(false)
  })

  it('preserves ordinary Close history cleanup and kill options', async () => {
    const provider = await start()
    const created = await spawn(provider)
    const request = vi.spyOn(provider['client'], 'request')

    await provider.shutdown(created.id, { immediate: false })

    expect(existsSync(historyTree(created.id))).toBe(false)
    expect(provider.hasPty(created.id)).toBe(false)
    expect(request.mock.calls.filter(([type]) => type === 'kill')).toEqual([
      ['kill', { sessionId: created.id, immediate: false }, undefined]
    ])
    expect(subprocess.kill).toHaveBeenCalledOnce()
    expect(subprocess.forceKill).not.toHaveBeenCalled()
  })
})
