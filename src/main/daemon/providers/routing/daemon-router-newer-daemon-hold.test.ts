import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NEWER_DAEMON_HOLD_ERROR } from '../../../../shared/terminal/daemon/newer-daemon-hold'
import { getDaemonPidPath, getDaemonSocketPath } from '../../launch/daemon-spawner'
import { SessionNotFoundError } from '../../protocol/daemon-errors'
import { PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import type { PtySpawnResult } from '../../../providers/pty/spawn-result'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import { discoverNewerProtocolHolds } from './daemon-newer-protocol-hold'
import { attachOrHold } from './daemon-router-newer-daemon-hold'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

const SESSION = 'wt::/repo@@held'
const NEWER = PROTOCOL_VERSION + 1

describe('attach-only lookups while a newer daemon may run the session', () => {
  const dirs: string[] = []
  let endpoint: Server | null = null

  afterEach(async () => {
    await new Promise<void>((resolve) => (endpoint ? endpoint.close(() => resolve()) : resolve()))
    endpoint = null
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    await discoverNewerProtocolHolds(join(tmpdir(), 'orca-no-such-runtime-dir'))
  })

  // A newer generation whose pid record is torn but whose endpoint answers cannot be ruled out.
  async function holdForNewerDaemon(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'orca-newer-hold-'))
    dirs.push(dir)
    writeFileSync(getDaemonPidPath(dir, NEWER), 'torn')
    endpoint = createServer(() => {})
    await new Promise<void>((resolve) => endpoint!.listen(getDaemonSocketPath(dir, NEWER), resolve))
    await discoverNewerProtocolHolds(dir)
    return dir
  }

  function attach(outcome: PtySpawnResult | Error, restorable: boolean): Promise<PtySpawnResult> {
    const resolver = {
      spawnAttachOnly: async () => {
        if (outcome instanceof Error) {
          throw outcome
        }
        return outcome
      }
    } as unknown as DaemonSessionOwnerResolver<DaemonPtyAdapter>
    const current = { hasRestorableHistory: () => restorable } as unknown as DaemonPtyAdapter
    return attachOrHold({ cols: 80, rows: 24 }, SESSION, resolver, current)
  }

  it('holds a restorable session this daemon does not know, instead of reporting it ended', async () => {
    await holdForNewerDaemon()
    await expect(attach(new SessionNotFoundError(SESSION), true)).rejects.toThrow(
      new Error(NEWER_DAEMON_HOLD_ERROR)
    )
  })

  it('reports the session ended when it has no history or no newer daemon holds', async () => {
    await holdForNewerDaemon()
    await expect(attach(new SessionNotFoundError(SESSION), false)).rejects.toBeInstanceOf(
      SessionNotFoundError
    )
    // The hold clears once the newer daemon's records are gone.
    for (const dir of dirs) {
      rmSync(getDaemonPidPath(dir, NEWER), { force: true })
      await discoverNewerProtocolHolds(dir)
    }
    await expect(attach(new SessionNotFoundError(SESSION), true)).rejects.toBeInstanceOf(
      SessionNotFoundError
    )
  })

  it('passes live attaches and other errors through unchanged', async () => {
    await holdForNewerDaemon()
    const live = { id: SESSION, isReattach: true } as PtySpawnResult
    await expect(attach(live, true)).resolves.toBe(live)
    const other = new Error('terminal_pane_owner_unverified')
    await expect(attach(other, true)).rejects.toBe(other)
  })
})
