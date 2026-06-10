import { afterAll, describe, expect, it, vi } from 'vitest'

// Live end-to-end harness for the ssh:connect pipeline against a real host.
// Skipped unless ORCA_LIVE_SSH_HOST is set; never runs in CI. Example:
//
//   ORCA_LIVE_SSH_HOST=192.168.1.73 ORCA_LIVE_SSH_USER=leyni \
//   ORCA_LIVE_SSH_IDENTITY=~/.ssh/id_ed25519 \
//   npx vitest run src/main/ssh/ssh-relay-live-connect.test.ts
//
// Replicates what ssh:connect does end to end: ssh2 connection → platform
// detection → relay upload + native deps install → relay launch → multiplexer
// round-trip → real PTY spawn (validates node-pty/ConPTY on the remote).

vi.mock('electron', () => ({
  // getLocalRelayCandidates falls back to <appPath>/out/relay/<platform>;
  // vitest runs from the repo root, where `pnpm build` leaves the relay.
  app: { getAppPath: () => process.cwd() }
}))

import { SshConnection } from './ssh-connection'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { resolveSshConfigHomePath } from './ssh-config-path-expansion'
import type { SshTarget } from '../../shared/ssh-types'

const LIVE_HOST = process.env.ORCA_LIVE_SSH_HOST
const LIVE_USER = process.env.ORCA_LIVE_SSH_USER ?? 'leyni'
// Reuse the SSH config home expander so `~` resolves with the right
// separators on Windows too, not just POSIX.
const LIVE_IDENTITY = resolveSshConfigHomePath(
  process.env.ORCA_LIVE_SSH_IDENTITY ?? '~/.ssh/id_ed25519'
)
const rawLivePort = process.env.ORCA_LIVE_SSH_PORT
const LIVE_PORT = rawLivePort ? Number.parseInt(rawLivePort, 10) : 22
if (!Number.isInteger(LIVE_PORT) || LIVE_PORT < 1 || LIVE_PORT > 65535) {
  throw new Error(`Invalid ORCA_LIVE_SSH_PORT: ${rawLivePort}`)
}

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
      } catch {
        // best-effort teardown; the relay's grace period reaps leftovers
      }
    }
  })

  it('connects, deploys the relay, and spawns a real PTY', { timeout: 360_000 }, async () => {
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

    // Same readiness probe ssh-relay-session uses before registering providers.
    const home = await mux.request('session.resolveHome', { path: '~' })
    log(`session.resolveHome -> ${JSON.stringify(home)}`)
    expect(home).toBeTruthy()

    // A real PTY proves node-pty (ConPTY on Windows) actually works remotely.
    const spawned = (await mux.request('pty.spawn', {
      cols: 80,
      rows: 24
    })) as { id: string }
    log(`pty.spawn -> id=${spawned.id}`)
    expect(spawned.id).toBeTruthy()

    await mux.request('pty.shutdown', { id: spawned.id })
    log('pty.shutdown ok — full connect pipeline verified')
  })
})
