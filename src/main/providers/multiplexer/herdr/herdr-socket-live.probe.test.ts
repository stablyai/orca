import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { HerdrSocketTransport } from './herdr-socket-transport'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Live-gated: only runs with HERDR_PROBE=1. Boots an isolated herdr server
// against a scratch HOME so it never touches a real session.
const RUN = process.env.HERDR_PROBE === '1'
const PROBE_HOME = '/tmp/herdr-socket-probe'
const SESSION = 'probe-test'
const HERDR = '/opt/homebrew/bin/herdr'

describe.skipIf(!RUN)('live herdr socket probe', () => {
  let server: ChildProcess | null = null

  beforeAll(async () => {
    server = spawn(HERDR, ['--session', SESSION, 'server'], {
      env: { ...process.env, HOME: PROBE_HOME },
      stdio: 'ignore'
    })
    const sock = join(PROBE_HOME, '.config/herdr/sessions', SESSION, 'herdr.sock')
    for (let i = 0; i < 100 && !existsSync(sock); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!existsSync(sock)) {
      throw new Error(`herdr server socket did not appear at ${sock}`)
    }
  }, 30000)

  afterAll(() => {
    try {
      execFileSync(HERDR, ['--session', SESSION, 'server', 'stop'], {
        env: { ...process.env, HOME: PROBE_HOME }
      })
    } catch {
      server?.kill()
    }
  })

  it('round-trips requests, applies a layout, and streams events', async () => {
    const transport = new HerdrSocketTransport({
      sessionName: SESSION,
      socketPath: join(PROBE_HOME, '.config/herdr/sessions', SESSION, 'herdr.sock'),
      timeoutMs: 5000
    })
    await transport.ensureSession(SESSION)

    const ping = (await transport.ping()) as { protocol?: number }
    expect(ping).toBeDefined()

    const layoutExport = (await transport.layoutExport({})) as {
      layout?: { root?: unknown }
    }
    expect(layoutExport).toBeDefined()

    const events: string[] = []
    transport.onEvent((event) => events.push(event.event))
    await transport.eventsSubscribe([])

    const workspaces = await transport.workspaceList()
    expect(workspaces).toBeDefined()

    await transport.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }, 30000)
})
