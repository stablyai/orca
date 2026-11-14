import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaudeFolderTrustFile from '../../claude/configuration/claude-folder-trust-file'

const CODEX_CONFIG_FILES = ['/orca/codex-home/config.toml', '/home/u/.codex/config.toml']

const mocks = vi.hoisted(() => ({
  codex: vi.fn<(path: string, configFiles: readonly string[]) => Promise<void>>(async () => {}),
  cursor: vi.fn<(path: string, home: string) => void>(),
  copilot: vi.fn<(path: string, home: string) => void>(),
  antigravity: vi.fn<(path: string, home: string, guestPath?: string) => void>(),
  qoder: vi.fn<(path: string, home: string) => void>(),
  kimi: vi.fn<(path: string, kimiHome: string) => void>(),
  codexConfigFiles: vi.fn<(agentHome: string) => string[]>(() => CODEX_CONFIG_FILES),
  claudeGrant: vi.fn<typeof ClaudeFolderTrustFile.grantClaudeWorkspaceTrust>()
}))

// The host filesystem uses Windows path resolution for WSL UNC identities.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof NodePath>()
  return {
    ...actual,
    resolve: (...paths: string[]) =>
      paths[0]?.startsWith('\\\\wsl.') ? actual.win32.resolve(...paths) : actual.resolve(...paths)
  }
})

vi.mock('./agent-trust-presets', () => ({
  markCodexProjectTrusted: mocks.codex,
  markCursorWorkspaceTrusted: mocks.cursor,
  markCopilotFolderTrusted: mocks.copilot,
  markAntigravityWorkspaceTrusted: mocks.antigravity,
  markKimiWorkspaceTrusted: mocks.kimi
}))
vi.mock('../../codex/configuration/homes/codex-home-paths', () => ({
  getLocalCodexTrustConfigFiles: mocks.codexConfigFiles
}))
vi.mock('../../qoder/workspace-trust', () => ({ markQoderWorkspaceTrusted: mocks.qoder }))
vi.mock('../../claude/configuration/claude-folder-trust-file', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeFolderTrustFile>()
  mocks.claudeGrant.mockImplementation(actual.grantClaudeWorkspaceTrust)
  return { ...actual, grantClaudeWorkspaceTrust: mocks.claudeGrant }
})

import { applyAgentWorkspaceTrust, type AgentTrustLaunchContext } from './agent-workspace-trust'
import { applyAgentWorkspaceTrustToSpawn } from './agent-workspace-trust-spawn'
import { clearWslHomeCache, rememberWslHome } from '../../wsl/discovery/wsl-home-cache'
const local: AgentTrustLaunchContext = {
  env: {},
  claudeAuth: null,
  wslDistro: null,
  connectionId: null
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('applyAgentWorkspaceTrust for Claude', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-agent-trust-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('respects the section repo choice and preserves ordinary root trust for outside starts', async () => {
    const workspaceRoot = join(root, 'folder')
    const outsideCwd = join(root, 'attached-worktree')
    mkdirSync(workspaceRoot)
    mkdirSync(outsideCwd)
    const config = join(root, '.claude.json')
    writeFileSync(config, '{}')
    const spawn = {
      ...local,
      env: { CLAUDE_CONFIG_DIR: root },
      launchAgent: 'claude',
      worktreeId: 'folder:section-parent',
      cwd: outsideCwd,
      store: { getFolderWorkspace: () => ({ folderPath: workspaceRoot }) },
      isFreshLaunch: true,
      settings: {},
      spawnOptions: {}
    }
    await applyAgentWorkspaceTrustToSpawn(spawn)
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({
      projects: { [workspaceRoot]: { hasTrustDialogAccepted: true } }
    })
    await applyAgentWorkspaceTrustToSpawn({
      ...spawn,
      trustWorktreeId: `repo::${outsideCwd}`,
      store: {
        ...spawn.store,
        getRepo: () => ({ agentWorkspaceTrust: 'agent-asks' })
      }
    })
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({
      projects: { [workspaceRoot]: { hasTrustDialogAccepted: true } }
    })
    await applyAgentWorkspaceTrustToSpawn({
      ...spawn,
      trustWorktreeId: `repo::${outsideCwd}`,
      store: {
        ...spawn.store,
        getRepo: () => ({ agentWorkspaceTrust: 'pre-trust' })
      }
    })
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({
      projects: {
        [workspaceRoot]: { hasTrustDialogAccepted: true },
        [outsideCwd]: { hasTrustDialogAccepted: true }
      }
    })
  })

  it('trusts a section root through a contained junction without granting the placement root', async () => {
    const workspaceRoot = join(root, 'folder')
    const outside = join(root, 'attached-worktree')
    mkdirSync(workspaceRoot)
    mkdirSync(outside)
    const linked = join(workspaceRoot, 'linked-child')
    symlinkSync(outside, linked, 'junction')
    const config = join(root, '.claude.json')
    writeFileSync(config, '{}')
    await applyAgentWorkspaceTrustToSpawn({
      ...local,
      env: { CLAUDE_CONFIG_DIR: root },
      launchAgent: 'claude',
      worktreeId: 'folder:section-parent',
      trustWorktreeId: `repo::${linked}`,
      cwd: linked,
      store: { getFolderWorkspace: () => ({ folderPath: workspaceRoot }) },
      isFreshLaunch: true,
      settings: {},
      spawnOptions: {}
    })
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({
      projects: {
        [linked]: { hasTrustDialogAccepted: true },
        [outside]: { hasTrustDialogAccepted: true }
      }
    })
  })

  it('writes the mounted-drive section root in the prepared WSL Claude config', async () => {
    const config = join(root, '.claude.json')
    writeFileSync(config, '{}')
    rememberWslHome('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\u')
    try {
      await applyAgentWorkspaceTrustToSpawn({
        ...local,
        launchAgent: 'claude',
        worktreeId: 'folder:section-parent',
        trustWorktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\mnt\\c\\repos\\child',
        cwd: '/mnt/c/repos/child',
        store: {
          getFolderWorkspace: () => ({ folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\folder' })
        },
        claudeAuth: {
          runtime: 'wsl',
          configDir: root,
          wslLinuxConfigDir: '/home/u/.claude',
          envPatch: { CLAUDE_CONFIG_DIR: '/home/u/.claude' },
          provenance: 'test'
        },
        wslDistro: 'Ubuntu',
        isFreshLaunch: true,
        settings: {},
        spawnOptions: {}
      })
      expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({
        projects: { '/mnt/c/repos/child': { hasTrustDialogAccepted: true } }
      })
    } finally {
      clearWslHomeCache()
    }
  })

  it('grants in the config file the final spawn env names', async () => {
    writeFileSync(join(root, '.claude.json'), '{}')
    await applyAgentWorkspaceTrust('claude', root, {
      ...local,
      env: { CLAUDE_CONFIG_DIR: root }
    })
    expect(JSON.parse(readFileSync(join(root, '.claude.json'), 'utf-8'))).toEqual({
      projects: { [root]: { hasTrustDialogAccepted: true } }
    })
  })
})
