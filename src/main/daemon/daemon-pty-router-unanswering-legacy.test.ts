import { createServer, type Socket } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import { getDaemonSocketPath } from './daemon-spawner'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function startUnansweringDaemon(): Promise<{ socketPath: string; tokenPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'unanswering-daemon-'))
  const socketPath = getDaemonSocketPath(dir, 47)
  const tokenPath = join(dir, 'daemon.token')
  writeFileSync(tokenPath, 'token')
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })
  return { socketPath, tokenPath }
}

describe('DaemonPtyRouter reattach beside an unanswering older daemon', () => {
  it('reattaches the exact restored session the current daemon still runs', async () => {
    const current = await startDaemonAdapterHarness(() => createMockSubprocess())
    cleanups.push(async () => {
      await current.server.shutdown()
      rmSync(current.dir, { recursive: true, force: true })
    })
    const spawned = await current.adapter.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'wt@@pane-1',
      isNewSession: true
    })
    expect(spawned.incarnationId).toEqual(expect.any(String))
    await current.adapter.disconnectOnly()

    const unanswering = await startUnansweringDaemon()
    const router = new DaemonPtyRouter({
      current: new DaemonPtyAdapter({
        socketPath: current.socketPath,
        tokenPath: current.tokenPath
      }),
      legacy: [new DaemonPtyAdapter({ ...unanswering, protocolVersion: 47 })]
    })
    cleanups.push(() => router.disconnectOnly())
    await router.discoverLegacySessions()

    const attach = {
      cols: 80,
      rows: 24,
      sessionId: 'wt@@pane-1',
      attachOnly: true,
      expectedIncarnationId: spawned.incarnationId
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(router.spawn(attach)).resolves.toMatchObject({
        id: 'wt@@pane-1',
        incarnationId: spawned.incarnationId,
        isReattach: true
      })
    }
    // Without incarnation evidence, the unanswered legacy daemon remains a possible owner.
    await expect(
      router.spawn({ cols: 80, rows: 24, sessionId: 'wt@@unproven', attachOnly: true })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
  }, 30_000)
})
