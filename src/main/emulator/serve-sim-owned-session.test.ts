import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ServeSimOwnedSessions } from './serve-sim-owned-session'

const A = 'A0000000-0000-0000-0000-000000000001'
const B = 'B0000000-0000-0000-0000-000000000002'

describe('owned iOS helper sessions', () => {
  it('keeps independently bound helpers and command state when another session stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-middleware-test-'))
    writeFileSync(
      join(dir, 'middleware.js'),
      `
      export function simMiddleware({ device }) {
        const handler = async (_req, res) => { res.end(device) }
        handler.handleUpgrade = (_req, socket) => socket.destroy()
        return handler
      }
    `
    )
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    const sessions = new ServeSimOwnedSessions()
    const executable = {
      command: process.execPath,
      baseArgs: [join(dir, 'serve-sim.js')],
      usesElectronAsNode: false
    }
    let first: Awaited<ReturnType<typeof sessions.start>> | undefined
    let second: Awaited<ReturnType<typeof sessions.start>> | undefined
    try {
      ;[first, second] = await Promise.all([
        sessions.start(A, executable, async () => {}),
        sessions.start(B, executable, async () => {})
      ])
      expect(first.streamUrl).not.toEqual(second.streamUrl)
      expect(await (await fetch(first.streamUrl)).text()).toBe(A)
      expect(await (await fetch(second.streamUrl)).text()).toBe(B)
      expect(sessions.stateRoot(A)).not.toEqual(sessions.stateRoot(B))
      expect((await fetch(first.streamUrl.replace(A, B))).status).toBe(404)
      expect(
        (await fetch(first.streamUrl.replace('/stream.mjpeg', `/../${B}/stream.mjpeg`))).status
      ).toBe(404)
      await sessions.stop(A, first.helperPid)
      expect(await (await fetch(second.streamUrl)).text()).toBe(B)
      expect(sessions.owns(first)).toBe(false)
      expect(sessions.owns(second)).toBe(true)
    } finally {
      if (first && sessions.owns(first)) {
        await sessions.stop(A, first.helperPid)
      }
      if (second && sessions.owns(second)) {
        await sessions.stop(B, second.helperPid)
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
