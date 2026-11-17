import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { hashOrcaHookTrustContent } from '../../../workspace-hooks/created-worktree-setup-trust'
import { runApprovedCreatedWorktreeSetup } from './created-worktree-approved-setup'
import { provisionWorktreeTerminals } from '../startup/runtime-worktree-terminal-provisioning'

const runner = vi.hoisted(() => ({ createSetupRunnerScript: vi.fn() }))
vi.mock('../../../workspace-hooks/worktree-runner-script', () => ({
  createSetupRunnerScript: runner.createSetupRunnerScript,
  resolveSetupRunnerShell: () => undefined
}))

const layout = vi.hoisted(() => ({ ownerIsMain: false }))
vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layout.ownerIsMain
  }
}))

const BRANCH_YAML =
  'scripts:\n  setup: make bootstrap\ndefaultTabs:\n  - title: dev\n    command: pnpm dev\n  - title: notes\n'

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
  layout.ownerIsMain = false
  rmSync(worktreePath, { recursive: true, force: true })
})

describe('runApprovedCreatedWorktreeSetup', () => {
  it('fails the call when an approved default tab could not start', async () => {
    writeFileSync(
      join(worktreePath, 'orca.yaml'),
      'defaultTabs:\n  - title: dev\n    command: pnpm dev\n'
    )
    provisionManagedWorktreeTerminals.mockImplementation((args) =>
      provisionWorktreeTerminals(
        {
          canSpawn: () => true,
          createTerminal: async () => {
            throw new Error('pty unavailable')
          },
          setTabTitle: async () => {},
          setTabColor: async () => {},
          getPtyId: () => undefined,
          recordSetupCompletionToken: () => {}
        },
        args
      )
    )

    await expect(
      runApprovedCreatedWorktreeSetup(
        runtimeFor(),
        'id:wt',
        hashOrcaHookTrustContent('# defaultTabs[1] dev\npnpm dev')
      )
    ).rejects.toThrow('Could not start')
  })

  it('starts approved default-tab commands although the layout already holds those tabs', async () => {
    layout.ownerIsMain = true
    writeFileSync(
      join(worktreePath, 'orca.yaml'),
      'defaultTabs:\n  - title: dev\n    command: pnpm dev\n'
    )
    const commands: (string | undefined)[] = []
    provisionManagedWorktreeTerminals.mockImplementation((args) =>
      provisionWorktreeTerminals(
        {
          canSpawn: () => true,
          createTerminal: async (_selector, options) => {
            commands.push(options.command)
            return { handle: 'h' }
          },
          applyDefaultTabs: async () => [],
          setTabTitle: async () => {},
          setTabColor: async () => {},
          getPtyId: () => undefined,
          recordSetupCompletionToken: () => {}
        },
        args
      )
    )

    await expect(
      runApprovedCreatedWorktreeSetup(
        runtimeFor(),
        'id:wt',
        hashOrcaHookTrustContent('# defaultTabs[1] dev\npnpm dev')
      )
    ).resolves.toEqual({ status: 'started' })
    expect(commands).toEqual(['pnpm dev'])
  })
})
