import type * as ProfileRouting from '../../shared/claude-profile-routing'
import type * as Os from 'node:os'
import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const fakeHome = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/orca-isolates-no-home`)
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => fakeHome
}))
vi.mock('../../shared/claude-profile-routing', async (original) => ({
  ...(await original<typeof ProfileRouting>()),
  claudeProfileRoutingEnabled: () => true
}))
import {
  getClaudeProfileRoutingAuthority,
  installClaudeProfileRoutingAuthority
} from './claude-profile-routing-authority'
import { createNativeClaudeProfileRouting } from './claude-profile-native-owner'
import { describeClaudeProfile, prepareClaudeProfileDirectory } from './claude-profile-paths'
import { discoverAiVaultSessionSources } from '../ai-vault/session-scanner-source-discovery'
import { isolatedScanRoots } from '../ai-vault/session-scanner-test-fixtures'
import { localAiVaultScanRoots } from '../ai-vault/cached-session-list'
import { discoverRetiredWorktreeNames } from '../worktree-retirement-discovery'
import { claudeProjectsRootDirs } from '../ai-vault/session-scanner-roots'
import { OrcaRuntimeService } from '../runtime/orca-runtime'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'profile-isolates-'))
  roots.push(root)
  return root
}

it('reads System Default where no owner is installed, as a scan worker or headless host does', async () => {
  const root = sandbox()
  const options = isolatedScanRoots(root)
  mkdirSync(join(options.codexSessionsDir, '2026', '10', '01'), { recursive: true })
  writeFileSync(
    join(options.codexSessionsDir, '2026', '10', '01', 'rollout-2026-10-01T00-00-00-a.jsonl'),
    '{}\n'
  )
  expect(getClaudeProfileRoutingAuthority()).toBeUndefined()
  const discoveries = await discoverAiVaultSessionSources({
    options,
    limitPerAgent: 10,
    issues: []
  })
  expect(discoveries.some((entry) => entry.agent === 'codex' && entry.files.length > 0)).toBe(true)
  await expect(
    discoverRetiredWorktreeNames({ workspaceRoots: [root], home: root, env: {} })
  ).resolves.toMatchObject({ complete: true })
  const status = new OrcaRuntimeService().getStatus()
  expect(status.capabilities).not.toContain('claude.profile-routing.v1')
})

it('scans the private profile history its parent resolved, and only then', async () => {
  const root = sandbox()
  const options = isolatedScanRoots(root)
  const privateProjects = join(root, 'profile', 'projects')
  mkdirSync(join(privateProjects, 'cwd'), { recursive: true })
  writeFileSync(join(privateProjects, 'cwd', 'private-session.jsonl'), '{}\n')
  const scan = (claudeProfileProjectsDirs?: string[]) =>
    discoverAiVaultSessionSources({
      options: { ...options, claudeProfileProjectsDirs },
      limitPerAgent: 10,
      issues: []
    }).then((found) =>
      found.filter((entry) => entry.agent === 'claude').flatMap((entry) => entry.files)
    )
  expect(await scan()).toEqual([])
  expect((await scan([privateProjects])).map((file) => file.path)).toEqual([
    join(privateProjects, 'cwd', 'private-session.jsonl')
  ])
})

it('hands an installed owner’s profile roots to the scan request', async () => {
  const root = sandbox()
  const dataRoot = join(root, 'data')
  const home = join(root, 'personal')
  mkdirSync(join(home, '.claude'), { recursive: true })
  const profile = describeClaudeProfile(dataRoot, 'a', {
    runtime: 'host',
    executionHostId: 'local'
  })
  prepareClaudeProfileDirectory(dataRoot, profile, home)
  installClaudeProfileRoutingAuthority(
    createNativeClaudeProfileRouting({
      store: {
        getSettings: () => ({
          claudeManagedAccounts: [],
          activeClaudeManagedAccountId: null,
          agentStatusHooksEnabled: false,
          disabledTuiAgents: []
        })
      },
      dataRoot,
      userHome: home,
      inheritedConfigDir: () => null,
      claudeVersion: async () => null,
      worker: { prepare: async () => ({ outcome: 'prepared', surfaces: {}, warnings: [] }) }
    })
  )
  expect((await localAiVaultScanRoots()).claudeProfileProjectsDirs).toEqual([
    join(home, '.claude', 'projects'),
    join(profile.home, 'projects')
  ])
  expect(new OrcaRuntimeService().getStatus().capabilities).toContain('claude.profile-routing.v1')
})

it('merges WSL guest roots verbatim, never realpathing a UNC path', () => {
  const realpath = vi.spyOn(fs.realpathSync, 'native')
  const guest = '\\\\wsl.localhost\\Ubuntu\\home\\u'
  const roots = claudeProjectsRootDirs({ wslHomeDirs: [guest] })
  expect(roots).toContain(join(guest, '.claude', 'projects'))
  expect(realpath.mock.calls.filter(([path]) => String(path).startsWith('\\\\wsl'))).toEqual([])
  expect(realpath).toHaveBeenCalled()
  realpath.mockRestore()
})
