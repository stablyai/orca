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

const WORKTREE_ID = 'repo-1::/tmp/worktrees/feature-r1'
const PROJECT = '/tmp/worktrees/feature-r1'
// Why: folder-project workspace sessions carry this suffix on an otherwise path-derived id.
const FOLDER_SUFFIX = '::workspace:5e8cc6b2-1d3f-4a5b-9c2d-7f6e5a4b3c2d'

function makeRuntimePurge() {
  const store = {
    getWorktreeMeta: () => ({ instanceId: 'old-instance' }),
    removeWorktreeMeta: () => {},
    getRepo: () => undefined,
    getSettings: () => ({})
  }
  const runtime = new OrcaRuntimeService(store as never)
  return (worktreeId: string) =>
    (
      runtime as unknown as {
        removeWorktreeMetadataAndHistory: (store: unknown, worktreeId: string) => void
      }
    ).removeWorktreeMetadataAndHistory(store, worktreeId)
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
})
