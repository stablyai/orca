/**
 * Fault injection over the real move driver and a real orcad profile store (an earlier
 * pattern): the desktop is killed at every point a clean move passes (each journal write, each
 * host call before it lands and after its reply is lost, each pause step, each desktop rewrite
 * store), optionally with orcad restarted too. After the restart and the reconnect, the move is
 * back at zero or fully moved, never in between; a second restart changes nothing; and a move
 * reset to zero can be run again from scratch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import { testState } from '../persistence-test-harness'
import {
  createWslMoveKillRig,
  removeWslMoveRigDirs,
  restartWslMoveRig,
  WSL_MOVE_RIG_REQUEST as request,
  wslMoveRigOutcome as outcomeOf,
  wslMoveRigRetentionStore as retentionStore,
  type WslMoveRig,
  type WslMoveRigOutcome as Outcome
} from '../__fixtures__/wsl-mover/wsl-move-kill-rig'
import type * as Journal from './wsl-move-cutover-journal'
import { resetWslMoveDesktopRewriteStoresForTests } from './wsl-move-desktop-rewrite-stores'
import { moveProjectsToWslHost } from './wsl-move-driver'
import { runWslMoveRetentionPass } from './wsl-move-retention'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 1 }))
}))

// The journal's writes and removals are kill points too; the hook is set per test.
const journalKill = vi.hoisted(() => {
  const hook: { at: ((name: string) => void) | null } = { at: null }
  return hook
})
vi.mock('./wsl-move-cutover-journal', async (importOriginal) => {
  const actual = await importOriginal<typeof Journal>()
  const around = <A extends unknown[]>(
    name: (...args: NoInfer<A>) => string,
    run: (...args: A) => void
  ) => {
    return (...args: A): void => {
      journalKill.at?.(`${name(...args)}:before`)
      run(...args)
      journalKill.at?.(`${name(...args)}:after`)
    }
  }
  return {
    ...actual,
    writeWslMoveCutover: around(
      (_path: string, cutover: Parameters<typeof actual.writeWslMoveCutover>[1]) =>
        `journal:${cutover.phase}`,
      actual.writeWslMoveCutover
    ),
    removeWslMoveCutover: around(() => 'journal:remove', actual.removeWslMoveCutover),
    removeUncommittedWslMoveCutover: around(
      () => 'journal:remove-uncommitted',
      actual.removeUncommittedWslMoveCutover
    )
  }
})

let rig: WslMoveRig

function newRig(): WslMoveRig {
  const next = createWslMoveKillRig()
  journalKill.at = next.at
  return next
}

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  // A killed process's catch handlers warn about the calls that now throw.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  rig = newRig()
})

afterEach(() => {
  journalKill.at = null
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  removeWslMoveRigDirs()
})

async function killedMove(r: WslMoveRig, killAt: string): Promise<void> {
  r.kill.killAt = killAt
  await moveProjectsToWslHost(r.world.deps, request).catch(() => {})
  // Retention runs on the journal change after the move, in the same process.
  await runWslMoveRetentionPass({ userDataPath: r.userDataPath, store: retentionStore(r) }).catch(
    () => {}
  )
  expect(r.kill.dead, `kill point ${killAt} fired`).toBe(true)
}

/** Every kill point a clean move passes, from a throwaway run. */
async function killPoints(): Promise<string[]> {
  const probe = newRig()
  const result = await moveProjectsToWslHost(probe.world.deps, request)
  expect(result).toMatchObject({ outcome: 'moved' })
  await runWslMoveRetentionPass({ userDataPath: probe.userDataPath, store: retentionStore(probe) })
  return [...new Set(probe.kill.points)]
}

describe('WSL move driver fault injection (real host store)', () => {
  it('a clean move ends fully moved on a real host store', async () => {
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'moved'
    })
    await runWslMoveRetentionPass({ userDataPath: rig.userDataPath, store: retentionStore(rig) })
    expect(outcomeOf(rig)).toBe('fully-moved')
  })

  it.each([false, true])(
    'every kill point ends at zero or fully moved, and survives a second restart (orcad restarted: %s)',
    { timeout: 120_000 },
    async (orcadRestarted) => {
      const points = await killPoints()
      expect(points.length).toBeGreaterThan(30)
      const matrix: Record<string, { hostDown: Outcome; hostUp: Outcome }> = {}
      for (const killAt of points) {
        const r = newRig()
        await killedMove(r, killAt)
        await restartWslMoveRig(r, { hostUp: false, orcadRestarted })
        const hostDown = outcomeOf(r)
        await restartWslMoveRig(r, { hostUp: true, orcadRestarted })
        const hostUp = outcomeOf(r)
        matrix[killAt] = { hostDown, hostUp }
        await restartWslMoveRig(r, { hostUp: true, orcadRestarted })
        expect(outcomeOf(r), `${killAt}: a second restart changes nothing`).toBe(hostUp)
        if (hostUp === 'back-at-zero') {
          const again = await moveProjectsToWslHost(r.world.deps, request)
          expect(again, `a fresh move after ${killAt}`).toMatchObject({ outcome: 'moved' })
        }
      }
      for (const [killAt, result] of Object.entries(matrix)) {
        expect(['back-at-zero', 'fully-moved'], `${killAt} with the host up`).toContain(
          result.hostUp
        )
        // Without the host, only a possible commit waits; everything else resolves locally.
        expect(
          ['back-at-zero', 'zero-abort-owed', 'fully-moved', 'waiting-for-host'],
          killAt
        ).toContain(result.hostDown)
      }
      // The commit point: a kill before the commit lands resets; one after it moves forward.
      expect(matrix['commit:before']).toEqual({
        hostDown: 'waiting-for-host',
        hostUp: 'back-at-zero'
      })
      expect(matrix['commit:lost-reply']).toEqual({
        hostDown: 'waiting-for-host',
        hostUp: 'fully-moved'
      })
      // A kill after the host staged: the desktop resets alone, and the stage goes on reconnect.
      expect(matrix['journal:destination-staged:after']).toEqual({
        hostDown: 'zero-abort-owed',
        hostUp: 'back-at-zero'
      })
      expect(matrix['store:browser:run']).toEqual({
        hostDown: 'fully-moved',
        hostUp: 'fully-moved'
      })
    }
  )
})
