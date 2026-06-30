import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ServeSimStateWatcher, type ServeSimStateDetectedEvent } from './serve-sim-state-watcher'

const TEST_UDID = '11111111-2222-3333-4444-555555555555'

async function waitForEvent(
  events: ServeSimStateDetectedEvent[],
  predicate: (event: ServeSimStateDetectedEvent) => boolean
): Promise<ServeSimStateDetectedEvent> {
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    const match = events.find(predicate)
    if (match) {
      return match
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for serve-sim watcher event. Received ${events.length}`)
}

describe('ServeSimStateWatcher', () => {
  const cleanupPaths: string[] = []

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  it('attaches to the serve-sim state directory when it appears after startup', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-serve-sim-watch-'))
    cleanupPaths.push(parentDir)
    const stateDir = join(parentDir, 'serve-sim')
    const watcher = new ServeSimStateWatcher({ parentDir, stateDir })
    const events: ServeSimStateDetectedEvent[] = []

    watcher.bindPty('pty-1', 'worktree-1')
    watcher.onDetected((event) => events.push(event))
    watcher.start()

    await mkdir(stateDir)
    await writeFile(
      join(stateDir, `server-${TEST_UDID}.json`),
      JSON.stringify({
        device: TEST_UDID,
        streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
        wsUrl: 'ws://127.0.0.1:3100/ws',
        pid: 12345
      })
    )

    const event = await waitForEvent(events, (candidate) => candidate.info.deviceUdid === TEST_UDID)
    expect(event).toMatchObject({
      worktreeId: 'worktree-1',
      source: 'state-file',
      info: {
        deviceUdid: TEST_UDID,
        streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
        wsUrl: 'ws://127.0.0.1:3100/ws',
        helperPid: 12345
      }
    })

    watcher.stop()
  })

  it('suppresses Orca-managed sessions only while they are marked managed', async () => {
    const watcher = new ServeSimStateWatcher()
    const events: ServeSimStateDetectedEvent[] = []
    const payload = JSON.stringify({
      device: TEST_UDID,
      streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3100/ws'
    })

    watcher.bindPty('pty-1', 'worktree-1')
    watcher.onDetected((event) => events.push(event))
    watcher.markOrcaManaged({
      deviceUdid: TEST_UDID,
      streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3100/ws'
    })
    watcher.ingestPtyOutput('pty-1', payload)
    expect(events).toHaveLength(0)

    watcher.unmarkOrcaManaged(TEST_UDID)
    watcher.ingestPtyOutput('pty-1', payload)
    expect(events).toHaveLength(1)
    expect(events[0]?.info.deviceUdid).toBe(TEST_UDID)

    watcher.stop()
  })

  it('prunes worktree-scoped dedupe keys on forget so a re-bound worktree re-emits', () => {
    const watcher = new ServeSimStateWatcher()
    const events: ServeSimStateDetectedEvent[] = []
    const payload = JSON.stringify({
      device: TEST_UDID,
      streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3100/ws',
      pid: 12345
    })

    watcher.onDetected((event) => events.push(event))

    watcher.bindPty('pty-1', 'worktree-1')
    watcher.ingestPtyOutput('pty-1', payload)
    watcher.ingestPtyOutput('pty-1', payload) // deduped within the same worktree
    expect(events).toHaveLength(1)

    // Forgetting the worktree must drop its dedupe keys; a re-bind is a fresh
    // context and should re-emit (otherwise the Set leaks for the session).
    watcher.forgetWorktree('worktree-1')
    watcher.bindPty('pty-2', 'worktree-1')
    watcher.ingestPtyOutput('pty-2', payload)
    expect(events).toHaveLength(2)

    watcher.stop()
  })

  it('dedupes one helper without hiding a later helper for the same simulator', () => {
    const watcher = new ServeSimStateWatcher()
    const events: ServeSimStateDetectedEvent[] = []
    const firstPayload = JSON.stringify({
      device: TEST_UDID,
      streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3100/ws',
      pid: 12345
    })
    const secondPayload = JSON.stringify({
      device: TEST_UDID,
      streamUrl: 'http://127.0.0.1:3101/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3101/ws',
      pid: 23456
    })

    watcher.bindPty('pty-1', 'worktree-1')
    watcher.onDetected((event) => events.push(event))

    watcher.ingestPtyOutput('pty-1', firstPayload)
    watcher.ingestPtyOutput('pty-1', firstPayload)
    watcher.ingestPtyOutput('pty-1', secondPayload)

    expect(events.map((event) => event.info.helperPid)).toEqual([12345, 23456])

    watcher.stop()
  })
})
