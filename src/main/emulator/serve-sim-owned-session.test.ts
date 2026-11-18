import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { ServeSimOwnedSessions } from './serve-sim-owned-session'
import { execServeSimCommand } from './serve-sim-execution'

const A = 'A0000000-0000-0000-0000-000000000001'
const B = 'B0000000-0000-0000-0000-000000000002'

describe('owned iOS helper sessions', () => {
  it('keeps independently bound helpers and command state when another session stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-middleware-test-'))
    writeFileSync(
      join(dir, 'middleware.js'),
      `
      export function simMiddleware({ device }) {
        const handler = async (req, res) => {
          if (req.url.startsWith('/api/event-log')) {
            res.end(JSON.stringify({events: [{device: new URL(req.url, 'http://localhost').searchParams.get('device')}]}))
          } else { res.end(device) }
        }
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
        sessions.start(
          A,
          executable,
          async () => {},
          async () => true
        ),
        sessions.start(
          B,
          executable,
          async () => {},
          async () => true
        )
      ])
      expect(first.streamUrl).not.toEqual(second.streamUrl)
      expect(await (await fetch(first.streamUrl)).text()).toBe(A)
      expect(await (await fetch(second.streamUrl)).text()).toBe(B)
      expect(sessions.stateRoot(A)).not.toEqual(sessions.stateRoot(B))
      expect(
        await (await fetch(new URL(`/api/event-log?device=${B}`, first.streamUrl))).json()
      ).toEqual({ events: [{ device: A }] })
      expect(
        await execServeSimCommand(
          {
            command: process.execPath,
            baseArgs: [resolve('node_modules/serve-sim/dist/serve-sim.js')],
            usesElectronAsNode: false
          },
          ['event-log', '--json', '-d', A],
          { json: true, stateRoot: sessions.stateRoot(A) }
        )
      ).toEqual({ events: [{ device: A }] })
      expect((await fetch(first.streamUrl.replace(A, B))).status).toBe(404)
      expect(
        (await fetch(first.streamUrl.replace('/stream.mjpeg', `/../${B}/stream.mjpeg`))).status
      ).toBe(404)
      await sessions.stop(A, first.helperPid)
      expect(await (await fetch(second.streamUrl)).text()).toBe(B)
      expect(sessions.owns(first)).toBe(false)
      expect(sessions.owns(second)).toBe(true)
      await expect(sessions.stop(A, first.helperPid)).resolves.toBeUndefined()
      const replacement = await sessions.start(
        A,
        executable,
        async () => {},
        async () => true
      )
      await expect(sessions.stop(A, first.helperPid)).rejects.toThrow('helper changed')
      const foreign = new ServeSimOwnedSessions()
      let finishShutdown: (() => void) | undefined
      const stopping = sessions.stop(
        A,
        replacement.helperPid,
        () =>
          new Promise<void>((resolve) => {
            finishShutdown = resolve
          })
      )
      await vi.waitFor(() => expect(finishShutdown).toBeDefined())
      await expect(
        foreign.start(
          A,
          executable,
          async () => {},
          async () => true
        )
      ).rejects.toThrow('claimed')
      finishShutdown!()
      await stopping
      const newer = await foreign.start(
        A,
        executable,
        async () => {},
        async () => true
      )
      const shutdown = vi.fn(async () => {})
      await expect(sessions.stop(A, replacement.helperPid, shutdown)).rejects.toThrow('No owned')
      expect(shutdown).not.toHaveBeenCalled()
      expect(foreign.owns(newer)).toBe(true)
      await foreign.stop(A, newer.helperPid)
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

  it('shares readiness for concurrent starts of the same device', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-middleware-concurrent-'))
    writeFileSync(
      join(dir, 'middleware.js'),
      `export function simMiddleware() {
      const handler = async (_req, res) => res.end('ok'); handler.handleUpgrade = () => {}; return handler
    }`
    )
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    const sessions = new ServeSimOwnedSessions()
    const executable = {
      command: process.execPath,
      baseArgs: [join(dir, 'serve-sim.js')],
      usesElectronAsNode: false
    }
    let complete: ((value: boolean) => void) | undefined
    const readiness = new Promise<boolean>((resolve) => {
      complete = resolve
    })
    const first = sessions.start(
      A,
      executable,
      async () => {},
      () => readiness
    )
    const second = sessions.start(
      A,
      executable,
      async () => {},
      async () => false
    )
    complete?.(true)
    const [a, b] = await Promise.all([first, second])
    try {
      expect(a).toEqual(b)
      expect(await (await fetch(a.streamUrl)).text()).toBe('ok')
    } finally {
      await sessions.stop(A, a.helperPid)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
