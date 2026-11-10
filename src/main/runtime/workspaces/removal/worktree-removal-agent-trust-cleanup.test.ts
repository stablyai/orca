import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { upsertOrcaCreatedProjectTrustLevel } from '../../../codex/trust/toml/config-toml-trust'
import { markAntigravityWorkspaceTrusted } from '../../../agent-launch/trust/agent-trust-presets'

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
  return (worktreeId: string, hostId?: ExecutionHostId, dropAgentTrust = true) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake store covers every member the purge reads.
    runtime.removeWorktreeMetadataAndHistory(store as never, worktreeId, hostId, { dropAgentTrust })
}

describe('worktree removal drops the workspace trust Orca wrote', () => {
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

  it('removes only the Antigravity trustedWorkspaces entry Orca appended', async () => {
    const agyHome = join(userDataDir, 'agy-home')
    const settingsPath = join(agyHome, '.gemini', 'antigravity-cli', 'settings.json')
    mkdirSync(join(agyHome, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'dark', trustedWorkspaces: ['/home/me/app'] })
    )
    markAntigravityWorkspaceTrusted(PROJECT, agyHome)

    await purgeWithMeta()(WORKTREE_ID)

    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual({
      theme: 'dark',
      trustedWorkspaces: ['/home/me/app']
    })
  })

  it('keeps an Antigravity entry that was trusted before Orca saw the path', async () => {
    const agyHome = join(userDataDir, 'agy-home')
    const settingsPath = join(agyHome, '.gemini', 'antigravity-cli', 'settings.json')
    mkdirSync(join(agyHome, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ trustedWorkspaces: [PROJECT] }))
    markAntigravityWorkspaceTrusted(PROJECT, agyHome)

    await purgeWithMeta()(WORKTREE_ID)

    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual({
      trustedWorkspaces: [PROJECT]
    })
  })
})
