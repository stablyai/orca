/**
 * An undo ("Use on this computer again") racing the move orchestrator on the same distro, over the
 * real driver, journal and undo path (the fault-injection rig). The undo's own host connect wakes
 * the orchestrator; its move or preview of that distro must not claim a run mid-undo, or the undo
 * refuses after it stopped the host's terminals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { testState } from '../persistence/persistence-test-harness'
import {
  createWslMoveKillRig,
  removeWslMoveRigDirs,
  WSL_MOVE_RIG_REQUEST as request,
  wslMoveRigRetentionStore,
  type WslMoveRig
} from '../persistence/__fixtures__/wsl-mover/wsl-move-kill-rig'
import { resetWslMoveDesktopRewriteStoresForTests } from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite-stores'
import { moveProjectsToWslHost } from '../persistence/moving-wsl-projects/wsl-move-driver'
import { previewWslMove } from '../persistence/moving-wsl-projects/wsl-move-driver-preview'
import { runWslMoveRetentionPass } from '../persistence/moving-wsl-projects/wsl-move-retention'
import {
  claimWslMoveRun,
  releaseWslMoveRun,
  type RunningWslMove
} from '../persistence/moving-wsl-projects/wsl-move-running-moves'
import { releaseWslMovedProjectHere } from './wsl-move-release-here'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 1 }))
}))

let rig: WslMoveRig
// Runs a test claimed by hand; released after it so the next test's move can claim.
const claimed: [string, RunningWslMove][] = []

function claim(distro: string): RunningWslMove | null {
  const run = claimWslMoveRun(distro)
  if (run) {
    claimed.push([distro, run])
  }
  return run
}

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  rig = createWslMoveKillRig()
})

afterEach(() => {
  for (const [distro, run] of claimed.splice(0)) {
    releaseWslMoveRun(distro, run)
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  removeWslMoveRigDirs()
})

async function movedProject(): Promise<void> {
  expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({ outcome: 'moved' })
  await runWslMoveRetentionPass({
    userDataPath: rig.userDataPath,
    store: wslMoveRigRetentionStore(rig)
  })
}

/** "Use on this computer again", stopped while the host's copies of the terminals stop. */
function pausedUndo(): {
  undo: ReturnType<typeof releaseWslMovedProjectHere>
  hostStopped: () => void
  stopsCalled: () => number
} {
  let hostStopped!: () => void
  const stopping = new Promise<void>((resolve) => {
    hostStopped = resolve
  })
  let stops = 0
  const undo = releaseWslMovedProjectHere(rig.userDataPath, { repoId: 'repo-1' }, [], () => ({
    stopHostCopies: async () => {
      stops += 1
      await stopping
      return 'stopped' as const
    }
  }))
  return { undo, hostStopped, stopsCalled: () => stops }
}

describe('an undo racing the move orchestrator on its distro', () => {
  it("refuses the orchestrator's move and preview of that distro mid-undo as undo-running, so the undo still releases", async () => {
    await movedProject()
    const { undo, hostStopped } = pausedUndo()

    // What the orchestrator runs when the undo's host connect wakes it.
    expect(await moveProjectsToWslHost(rig.world.deps, request)).toMatchObject({
      outcome: 'refused',
      code: 'wsl_move_undo_running'
    })
    // The orchestrator's preview settles an interrupted move, so it claims the run as a move does.
    expect(
      await previewWslMove(rig.world.deps, request, { settleInterrupted: 'finish-at-restart' })
    ).toMatchObject({
      outcome: 'refused',
      code: 'wsl_move_undo_running'
    })
    expect(claim('Debian')).not.toBeNull()

    hostStopped()
    expect(await undo).toMatchObject({ released: true, repoIds: ['repo-1'] })
    // Undone: a later trigger may claim again (the orchestrator parks the distro as declined).
    expect(claim(request.distro)).not.toBeNull()
  })

  it("refuses before the host's terminals stop when a move of the distro was already running", async () => {
    await movedProject()
    const running = claim(request.distro)
    expect(running).not.toBeNull()

    const { undo, hostStopped, stopsCalled } = pausedUndo()
    hostStopped()

    expect(await undo).toMatchObject({ released: false, reason: 'move-running' })
    expect(stopsCalled()).toBe(0)
  })
})
