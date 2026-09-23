import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectGroup } from '../../../shared/project-groups'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import type { Store } from '../../persistence'
import { createPtyIpcSpawnState } from './ipc/spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './ipc/spawn-types'
import { preparePtyIpcSpawnPreflight } from './ipc/spawn-preflight'
import { assemblePtyIpcSpawnEnv } from './ipc/spawn-env'
import { buildPtyIpcSpawnOptions } from './ipc/spawn-options'
import { createRuntimePtySpawnState } from './runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from './runtime/controller-deps'
import { prepareRuntimePtySpawn } from './runtime/spawn-preflight'
import { buildRuntimePtySpawnOptions } from './runtime/spawn-options'

// Only the credential-store read is substituted; binding, preflight, and spawn options are real.
vi.mock('../../rate-limits/claude-oauth-credentials', () => ({
  readClaudeConfigDirScopedOAuthCredentials: async () => ({
    token: 'fixture',
    source: 'credentials-file'
  })
}))

const home = mkdtempSync(join(tmpdir(), 'claude-group-spawn-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

function catalog(configDir: string | null): Store {
  const group = {
    ...createProjectGroup({ name: 'Uniqcast', createdFrom: 'manual', tabOrder: 0 }),
    claudeConfigDir: configDir
  }
  const child = createProjectGroup({
    name: 'Nested',
    createdFrom: 'manual',
    tabOrder: 1,
    parentGroupId: group.id
  })
  const folder: FolderWorkspace = {
    id: 'workspace',
    projectGroupId: child.id,
    name: 'workspace',
    folderPath: home,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
  const repo: Repo = {
    id: 'repo',
    path: home,
    displayName: 'dispatcher',
    badgeColor: '',
    addedAt: 0,
    projectGroupId: child.id
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these spawn stages only read the catalog; persistence is disabled in this fixture.
  return {
    hasHydratedProjectCatalog: () => true,
    getProjectGroups: () => [group, child],
    getRepos: () => [repo],
    getFolderWorkspaces: () => [folder]
  } as unknown as Store
}

async function spawnOptions(
  lane: 'desktop' | 'runtime',
  configDir: string | null,
  env?: Record<string, string>,
  worktreeId = 'folder:workspace'
) {
  const deps = {
    store: catalog(configDir),
    prepareClaudeAuth: async () => ({
      configDir: '/personal',
      envPatch: { CLAUDE_CONFIG_DIR: '/personal' },
      stripAuthEnv: false,
      provenance: 'personal'
    }),
    assertFolderWorkspacePtyPathUsable: () => undefined,
    resolvePtySpawnStartupCwd: (_id: unknown, cwd: string | undefined) => cwd,
    transitionSpawnHiddenRendererPtyDeliveryState: () => {},
    prepareCodexResumeHome: () => null,
    noCodexResumeLaunch: (command: string | undefined) => ({
      command,
      codexResumeHome: null,
      notifyResumeUnavailable: false,
      droppedResumeArgv: false,
      providerSession: null
    }),
    stripSequencedStartupResumeArgv: (value: unknown) => value
  }
  const args = {
    cols: 80,
    rows: 24,
    cwd: home,
    worktreeId,
    command: 'claude --dangerously-skip-permissions',
    launchAgent: 'claude',
    env
  } satisfies PtySpawnIpcArgs
  if (lane === 'desktop') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only preflight and option assembly run; provider execution and persistence dependencies are unused.
    const ctx = createPtyIpcSpawnState(deps as unknown as PtySpawnIpcDeps, args)
    await preparePtyIpcSpawnPreflight(ctx)
    await assemblePtyIpcSpawnEnv(ctx)
    await buildPtyIpcSpawnOptions(ctx)
    ctx.finishTerminalInstall()
    return ctx.spawnOptions
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only preflight and option assembly run; provider execution and persistence dependencies are unused.
  const ctx = createRuntimePtySpawnState(deps as unknown as PtyRuntimeControllerDeps, args)
  await prepareRuntimePtySpawn(ctx)
  await buildRuntimePtySpawnOptions(ctx)
  ctx.finishTerminalInstall()
  return ctx.spawnOptions
}

for (const lane of ['desktop', 'runtime'] as const) {
  describe(`${lane} Claude group account`, () => {
    it('passes the inherited group directory to the PTY instead of the personal account', async () => {
      const options = await spawnOptions(lane, home)
      expect(options.env?.CLAUDE_CONFIG_DIR).toBe(home)
      expect(options.envToDelete).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    })
    it('keeps the group account when an earlier launch stage already pinned it', async () => {
      expect(
        (await spawnOptions(lane, home, { CLAUDE_CONFIG_DIR: home })).env?.CLAUDE_CONFIG_DIR
      ).toBe(home)
    })
    it('refuses a missing group directory rather than launching the personal account', async () => {
      await expect(spawnOptions(lane, join(home, 'missing'))).rejects.toThrow(
        'not an existing directory'
      )
    })
    it('applies the group account to a repository worktree', async () => {
      expect(
        (await spawnOptions(lane, home, undefined, `repo::${home}`)).env?.CLAUDE_CONFIG_DIR
      ).toBe(home)
    })
    it('rejects a conflicting explicit config directory', async () => {
      await expect(
        spawnOptions(lane, home, { CLAUDE_CONFIG_DIR: '/other-account' })
      ).rejects.toThrow('launch environment sets CLAUDE_CONFIG_DIR')
    })
    it('rejects explicit credentials that could override the team account', async () => {
      await expect(
        spawnOptions(lane, home, { CLAUDE_CODE_OAUTH_TOKEN: 'personal-token' })
      ).rejects.toThrow('explicit Anthropic auth')
    })
    it('preserves the selected account for unbound workspaces', async () => {
      expect((await spawnOptions(lane, null)).env?.CLAUDE_CONFIG_DIR).toBe('/personal')
    })
  })
}
