import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { hashOrcaHookTrustContent } from '../../../workspace-hooks/created-worktree-setup-trust'
import { runApprovedCreatedWorktreeSetup } from './created-worktree-approved-setup'

const runner = vi.hoisted(() => ({ createSetupRunnerScript: vi.fn() }))
vi.mock('../../../workspace-hooks/worktree-runner-script', () => ({
  createSetupRunnerScript: runner.createSetupRunnerScript,
  resolveSetupRunnerShell: () => undefined
}))

const BRANCH_YAML =
  'scripts:\n  setup: make bootstrap\ndefaultTabs:\n  - title: dev\n    command: pnpm dev\n  - title: notes\n'
const BRANCH_TRUST_CONTENT = 'make bootstrap\n\n# defaultTabs[1] dev\npnpm dev'

let worktreePath: string
let repo: Repo
const provisionManagedWorktreeTerminals = vi.fn()

function runtimeFor() {
  const worktree = {
    id: `repo::${worktreePath}`,
    repoId: 'repo',
    path: worktreePath,
    displayName: 'w'
  }
  return {
    showManagedWorktree: vi.fn(async () => worktree),
    requireStore: () => ({
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getSettings: () => getDefaultSettings(tmpdir())
    }),
    provisionManagedWorktreeTerminals
  }
}

beforeEach(() => {
  worktreePath = mkdtempSync(join(tmpdir(), 'orca-approved-setup-'))
  repo = { id: 'repo', path: '/primary', displayName: 'r', badgeColor: '', addedAt: 0 }
  writeFileSync(join(worktreePath, 'orca.yaml'), BRANCH_YAML)
  provisionManagedWorktreeTerminals.mockReset().mockResolvedValue({ setupSpawned: true })
  runner.createSetupRunnerScript.mockReset().mockResolvedValue({
    runnerScriptPath: join(worktreePath, 'runner.sh'),
    envVars: {}
  })
})

afterEach(() => {
  rmSync(worktreePath, { recursive: true, force: true })
})

describe('runApprovedCreatedWorktreeSetup', () => {
  it('runs nothing when the content changed after the user approved it', async () => {
    const result = await runApprovedCreatedWorktreeSetup(
      runtimeFor(),
      'id:wt',
      hashOrcaHookTrustContent('make bootstrap')
    )

    expect(result).toEqual({
      status: 'mismatch',
      setupTrustMismatch: {
        contentHash: hashOrcaHookTrustContent(BRANCH_TRUST_CONTENT),
        scriptContent: BRANCH_TRUST_CONTENT
      }
    })
    expect(runner.createSetupRunnerScript).not.toHaveBeenCalled()
    expect(provisionManagedWorktreeTerminals).not.toHaveBeenCalled()
  })
})
