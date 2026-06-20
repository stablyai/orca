import { afterAll, describe, expect, it, vi } from 'vitest'

// Live end-to-end harness for ssh:connect against a real host. Skipped unless
// ORCA_LIVE_SSH_HOST is set; never runs in normal CI or unit-test loops.
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() }
}))

import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { SshConnection } from './ssh-connection'
import { resolveSshConfigHomePath } from './ssh-config-path-expansion'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import type { SshTarget } from '../../shared/ssh-types'

const LIVE_HOST = process.env.ORCA_LIVE_SSH_HOST
const LIVE_USER = process.env.ORCA_LIVE_SSH_USER ?? process.env.USERNAME ?? process.env.USER ?? ''
const LIVE_IDENTITY = resolveSshConfigHomePath(
  process.env.ORCA_LIVE_SSH_IDENTITY ?? '~/.ssh/id_ed25519'
)
const rawLivePort = process.env.ORCA_LIVE_SSH_PORT
const LIVE_PORT = rawLivePort ? Number.parseInt(rawLivePort, 10) : 22

const startedAt = Date.now()
function log(step: string): void {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`[live-connect +${elapsed}s] ${step}`)
}

describe.skipIf(!LIVE_HOST)('live ssh:connect pipeline', () => {
  const cleanups: (() => Promise<void> | void)[] = []

  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (err) {
        // Best-effort teardown; the relay grace period reaps leftovers.
        log(`cleanup error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })

  it('connects, deploys the relay, and spawns a real PTY', { timeout: 360_000 }, async () => {
    if (!Number.isInteger(LIVE_PORT) || LIVE_PORT < 1 || LIVE_PORT > 65535) {
      throw new Error(`Invalid ORCA_LIVE_SSH_PORT: ${rawLivePort}`)
    }

    const target: SshTarget = {
      id: 'live-connect-harness',
      label: 'live-connect-harness',
      host: LIVE_HOST!,
      port: LIVE_PORT,
      username: LIVE_USER,
      identityFile: LIVE_IDENTITY,
      source: 'manual'
    }

    log(`connecting to ${LIVE_USER}@${LIVE_HOST}:${LIVE_PORT}`)
    const conn = new SshConnection(target, {
      onStateChange: (_id, state) => {
        log(`state=${state.status}${state.error ? ` error=${state.error}` : ''}`)
      }
    })
    cleanups.push(() => conn.disconnect())
    await conn.connect()
    log('ssh connection established')

    const deployed = await deployAndLaunchRelay(
      conn,
      (status) => log(`deploy: ${status}`),
      30,
      'live-connect-harness'
    )
    log(`relay launched (remoteRelayDir=${deployed.remoteRelayDir})`)

    const mux = new SshChannelMultiplexer(deployed.transport)
    cleanups.push(() => mux.dispose())

    const home = await mux.request('session.resolveHome', { path: '~' })
    log(`session.resolveHome -> ${JSON.stringify(home)}`)
    expect(home).toBeTruthy()

    const spawned = (await mux.request('pty.spawn', {
      cols: 80,
      rows: 24
    })) as { id: string }
    log(`pty.spawn -> id=${spawned.id}`)
    expect(spawned.id).toBeTruthy()

    await mux.request('pty.shutdown', { id: spawned.id })
    log('pty.shutdown ok: full connect pipeline verified')
  })
})
