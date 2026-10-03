/**
 * Worktree removal drops the Codex project trust entries Orca created for the
 * worktree's path: path-derived ids get reused, so a stale entry would
 * pre-trust whatever occupies the path next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'
import { upsertOrcaCreatedProjectTrustLevel } from '../codex/config-toml-trust'
import { runExclusivelyForCodexTrustConfig } from '../codex/codex-trust-config-mutation-queue'

const WORKTREE_ID = 'repo-1::/tmp/worktrees/feature-r1'
const PROJECT = '/tmp/worktrees/feature-r1'
// Why: folder-project workspace sessions carry this suffix on an otherwise path-derived id.
const FOLDER_SUFFIX = '::workspace:5e8cc6b2-1d3f-4a5b-9c2d-7f6e5a4b3c2d'

function makeRuntimePurge(meta: Record<string, unknown> = {}) {
  const store = {
    getWorktreeMeta: () => meta,
    getRepos: () => [] as never[],
    removeWorktreeMeta: () => {},
    getRepo: () => undefined,
    getSettings: () => ({})
  }
  const runtime = new OrcaRuntimeService(store as never)
  return (worktreeId: string, hostId?: string) =>
    (
      runtime as unknown as {
        removeWorktreeMetadataAndHistory: (
          store: unknown,
          worktreeId: string,
          hostId?: string
        ) => void | Promise<void>
      }
    ).removeWorktreeMetadataAndHistory(store, worktreeId, hostId)
}

describe('worktree removal cleans up the Codex pretrust Orca wrote', () => {
  let userDataDir: string
  let configPath: string
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-pretrust-removal-'))
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = userDataDir
    const managedHome = join(userDataDir, 'codex-runtime-home', 'home')
    mkdirSync(managedHome, { recursive: true })
    configPath = join(managedHome, 'config.toml')
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
  })

  it('removes the recorded entry when the worktree metadata is purged', async () => {
    upsertOrcaCreatedProjectTrustLevel(configPath, PROJECT, 'trusted')
    const purge = makeRuntimePurge()

    purge(WORKTREE_ID)

    // The purge fires the cleanup through the trust-config queue, so poll for the write.
    await vi.waitFor(() => {
      expect(readFileSync(configPath, 'utf-8')).not.toContain(`[projects."${PROJECT}"]`)
    })
  })

  it('removes the entry for a folder-workspace session id suffixing the same path', async () => {
    upsertOrcaCreatedProjectTrustLevel(configPath, PROJECT, 'trusted')
    const purge = makeRuntimePurge()

    purge(`${WORKTREE_ID}${FOLDER_SUFFIX}`)

    await vi.waitFor(() => {
      expect(readFileSync(configPath, 'utf-8')).not.toContain(`[projects."${PROJECT}"]`)
    })
  })

  it('keeps the entry while another host still owns the same path-derived id', async () => {
    upsertOrcaCreatedProjectTrustLevel(configPath, PROJECT, 'trusted')
    const purge = makeRuntimePurge({ hostId: 'host-b' })

    purge(WORKTREE_ID, 'host-a')

    // Why: the cleanup is fire-and-forget, so the negative needs a settle window to be meaningful.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(readFileSync(configPath, 'utf-8')).toContain(`[projects."${PROJECT}"]`)
  })

  it('still removes the entry when the removal host owns the metadata row', async () => {
    upsertOrcaCreatedProjectTrustLevel(configPath, PROJECT, 'trusted')
    const purge = makeRuntimePurge({ hostId: 'host-a' })

    purge(WORKTREE_ID, 'host-a')

    await vi.waitFor(() => {
      expect(readFileSync(configPath, 'utf-8')).not.toContain(`[projects."${PROJECT}"]`)
    })
  })

  it('does not complete the purge before the recorded entry is deleted', async () => {
    upsertOrcaCreatedProjectTrustLevel(configPath, PROJECT, 'trusted')
    // Why: holding the config's mutation lane parks the cleanup, so "the purge
    // finished" and "the entry is gone" can be told apart. A recreated path
    // inherits trust_level = "trusted" if the purge reports completion first.
    let releaseLane!: () => void
    const laneHeld = new Promise<void>((resolve) => {
      releaseLane = resolve
    })
    const hold = runExclusivelyForCodexTrustConfig(configPath, () => laneHeld)
    const purge = makeRuntimePurge()

    const removalAck = purge(WORKTREE_ID)

    // The cleanup is queued behind the held lane: nothing landed yet.
    expect(readFileSync(configPath, 'utf-8')).toContain(`[projects."${PROJECT}"]`)
    // A settled purge here is the bug: the removal ack must wait for the
    // deletion that is still parked on the config lane. A 0ms macrotask loses
    // to any settled ack (microtasks first) and wins only against a pending one.
    const settledBeforeCleanup = await Promise.race([
      Promise.resolve(removalAck).then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 0)
      })
    ])
    expect(settledBeforeCleanup).toBe(false)
    releaseLane()
    await hold
    await removalAck
    expect(readFileSync(configPath, 'utf-8')).not.toContain(`[projects."${PROJECT}"]`)
  })

  it('hands the folder-workspace forgetting dep the purge promise, not void', async () => {
    // Why parked: the wired dep used to void the purge promise, so the folder
    // delete had nothing to await and a forgotten workspace could report
    // before the recorded entry was deleted.
    let releasePurge!: () => void
    const purgeParked = new Promise<void>((resolve) => {
      releasePurge = resolve
    })
    const store = {
      getWorktreeMeta: () => ({}),
      getRepos: () => [] as never[],
      removeWorktreeMeta: () => {},
      getRepo: () => undefined,
      getSettings: () => ({})
    }
    const runtime = new OrcaRuntimeService(store as never)
    const purgeSpy = vi
      .spyOn(
        runtime as unknown as {
          removeWorktreeMetadataAndHistory: (store: unknown, worktreeId: string) => Promise<void>
        },
        'removeWorktreeMetadataAndHistory'
      )
      .mockReturnValue(purgeParked)
    const cleanupRemovedFolderWorkspaceState = (
      runtime as unknown as {
        projectGroups: {
          deps: {
            cleanupRemovedFolderWorkspaceState: (worktreeId: string) => void | Promise<void>
          }
        }
      }
    ).projectGroups.deps.cleanupRemovedFolderWorkspaceState

    const cleanup = cleanupRemovedFolderWorkspaceState('folder:ws-1')
    expect(purgeSpy).toHaveBeenCalledWith(expect.anything(), 'folder:ws-1')

    // Voiding the promise made this resolve instantly; the dep must hand the
    // caller the still-pending purge to await.
    let settledEarly = false
    void Promise.resolve(cleanup).then(() => {
      settledEarly = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settledEarly).toBe(false)
    releasePurge()
    await cleanup
  })
})
