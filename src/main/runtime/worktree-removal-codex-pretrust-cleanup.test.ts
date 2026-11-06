import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'
import type { ExecutionHostId } from '../../shared/execution-host'
import { upsertOrcaCreatedProjectTrustLevel } from '../codex/trust/toml/config-toml-trust'

const WORKTREE_ID = 'repo-1::/tmp/worktrees/feature-r1'
const PROJECT = '/tmp/worktrees/feature-r1'

function purgeWithMeta(meta: Record<string, unknown> = {}) {
  const store = {
    getWorktreeMeta: () => meta,
    getRepos: () => [],
    removeWorktreeMeta: () => {},
    getRepo: () => undefined,
    getSettings: () => ({})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service constructor only reads the store members the fake supplies.
  const runtime = new OrcaRuntimeService(store as never)
  return (worktreeId: string, hostId?: ExecutionHostId) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake store covers every member the purge reads.
    runtime.removeWorktreeMetadataAndHistory(store as never, worktreeId, hostId)
}

describe('worktree removal drops the Codex pretrust Orca wrote', () => {
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
    upsertOrcaCreatedProjectTrustLevel(configPath, PROJECT, 'trusted')
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
  })

  it('removes the recorded entry before the purge resolves', async () => {
    await purgeWithMeta()(WORKTREE_ID)

    expect(readFileSync(configPath, 'utf-8')).not.toContain(`[projects."${PROJECT}"]`)
  })

  it('finds the bare path behind a folder-workspace session id suffix', async () => {
    await purgeWithMeta()(`${WORKTREE_ID}::workspace:5e8cc6b2-1d3f-4a5b-9c2d-7f6e5a4b3c2d`)

    expect(readFileSync(configPath, 'utf-8')).not.toContain(`[projects."${PROJECT}"]`)
  })

  it('keeps the entry while another host still owns the same path-derived id', async () => {
    await purgeWithMeta({ hostId: 'ssh:host-b' })(WORKTREE_ID, 'ssh:host-a')

    expect(readFileSync(configPath, 'utf-8')).toContain(`[projects."${PROJECT}"]`)
  })
})
