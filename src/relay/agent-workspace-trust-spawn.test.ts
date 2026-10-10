import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as Os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTrustPreset } from '../main/agent-trust-presets'
import type { TuiAgent } from '../shared/tui-agent'
import { linkGitWorktree, workspaceTrustWritten } from '../main/workspace-trust-test-fixtures'

const state = vi.hoisted(() => ({ home: '' }))

// Why: a spawn env without HOME leaves the writers on this process's home, as on a real relay.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: () => state.home }
})

import { applyRelayAgentWorkspaceTrust } from './agent-workspace-trust-spawn'
import { buildSshPtySpawnRequest } from '../main/providers/ssh-pty-spawn-request'

const HOST_SHELL = { wslShell: false }
const ORIGINAL_CLAUDE_CONFIG = '{"oauthAccount":{"x":1}}'
const AGENTS_WITH_A_RELAY_WRITER: [TuiAgent, AgentTrustPreset][] = [
  ['claude', 'claude'],
  ['claude-agent-teams', 'claude'],
  ['codex', 'codex'],
  ['cursor', 'cursor'],
  ['copilot', 'copilot'],
  ['qoder', 'qoder'],
  ['qoder-cn', 'qoder-cn']
]
const AGENTS_THAT_INHERIT_TRUST = AGENTS_WITH_A_RELAY_WRITER.filter(([, preset]) =>
  ['claude', 'copilot', 'qoder', 'qoder-cn'].includes(preset)
)
const ALL_PRESETS: AgentTrustPreset[] = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'qoder',
  'qoder-cn',
  'antigravity'
]

let root: string
let home: string
let workspace: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-relay-agent-trust-')))
  home = join(root, 'home', 'me')
  mkdirSync(home, { recursive: true })
  state.home = home
  writeFileSync(join(home, '.claude.json'), ORIGINAL_CLAUDE_CONFIG, { mode: 0o600 })
  workspace = join(root, 'wt')
  mkdirSync(workspace)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function nothingWritten(): boolean {
  return ALL_PRESETS.every((preset) => !workspaceTrustWritten(home, preset))
}

describe('applyRelayAgentWorkspaceTrust', () => {
  it.each(AGENTS_WITH_A_RELAY_WRITER)(
    "writes %s trust on the relay host's own disk",
    async (agent, preset) => {
      await applyRelayAgentWorkspaceTrust(
        { workspacePath: workspace },
        agent,
        { HOME: home },
        HOST_SHELL
      )
      expect(workspaceTrustWritten(home, preset)).toBe(true)
    }
  )

  it("grants Claude in the remote host's own config, named by the merged spawn env", async () => {
    const configDir = join(root, 'cfg')
    mkdirSync(configDir)
    writeFileSync(join(configDir, '.claude.json'), ORIGINAL_CLAUDE_CONFIG, { mode: 0o600 })
    await applyRelayAgentWorkspaceTrust(
      { workspacePath: workspace },
      'claude',
      { CLAUDE_CONFIG_DIR: configDir, HOME: home },
      HOST_SHELL
    )
    expect(JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf-8'))).toEqual({
      oauthAccount: { x: 1 },
      projects: { [workspace]: { hasTrustDialogAccepted: true } }
    })
    expect(readFileSync(join(home, '.claude.json'), 'utf-8')).toBe(ORIGINAL_CLAUDE_CONFIG)
  })

  it('never creates a Claude config file Claude has not written', async () => {
    const emptyHome = join(root, 'empty-home')
    mkdirSync(emptyHome)
    await applyRelayAgentWorkspaceTrust(
      { workspacePath: workspace },
      'claude',
      { HOME: emptyHome },
      HOST_SHELL
    )
    expect(existsSync(join(emptyHome, '.claude.json'))).toBe(false)
  })

  it('writes Codex trust into the CODEX_HOME the spawn env names', async () => {
    const codexHome = join(root, 'codex-home')
    await applyRelayAgentWorkspaceTrust(
      { workspacePath: workspace },
      'codex',
      { HOME: home, CODEX_HOME: codexHome },
      HOST_SHELL
    )
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf-8')).toContain(
      `[projects."${workspace}"]`
    )
    expect(workspaceTrustWritten(home, 'codex')).toBe(false)
  })

  it("stores a Codex worktree's own path, not the relay home it hangs off, as a local launch does", async () => {
    const worktree = join(root, 'worktrees', 'feature')
    linkGitWorktree(home, worktree)
    await applyRelayAgentWorkspaceTrust(
      { workspacePath: worktree },
      'codex',
      { HOME: home },
      HOST_SHELL
    )
    const written = readFileSync(join(home, '.codex', 'config.toml'), 'utf-8')
    expect(written).toContain(`[projects."${worktree}"]`)
    expect(written).not.toContain(`[projects."${home}"]`)
  })

  it.each([
    ['codex', 'codex'],
    ['cursor', 'cursor']
  ] as const)(
    'trusts the relay home for %s, whose trust there covers only the home',
    async (agent, preset) => {
      await applyRelayAgentWorkspaceTrust(
        { workspacePath: home },
        agent,
        { HOME: home },
        HOST_SHELL
      )
      expect(workspaceTrustWritten(home, preset)).toBe(true)
    }
  )

  const tooBroad: [string, () => string][] = [
    ['the relay home', () => home],
    ['a folder containing the relay home', () => join(root, 'home')],
    [
      'a symlink to the relay home',
      () => {
        symlinkSync(home, join(workspace, 'home-link'), 'junction')
        return join(workspace, 'home-link')
      }
    ]
  ]
  describe.each(tooBroad)('for %s', (_label, arrange) => {
    it.each(AGENTS_THAT_INHERIT_TRUST)('writes no %s trust', async (agent) => {
      await applyRelayAgentWorkspaceTrust(
        { workspacePath: arrange() },
        agent,
        { HOME: home },
        HOST_SHELL
      )
      expect(nothingWritten()).toBe(true)
    })
  })

  it.each(AGENTS_WITH_A_RELAY_WRITER)(
    "never writes this host's files for %s started in a WSL guest",
    async (agent) => {
      await applyRelayAgentWorkspaceTrust(
        { workspacePath: workspace },
        agent,
        { HOME: home },
        { wslShell: true }
      )
      expect(nothingWritten()).toBe(true)
    }
  )

  it('leaves Antigravity to ask, since its writer is unverified on SSH hosts', async () => {
    await applyRelayAgentWorkspaceTrust(
      { workspacePath: workspace },
      'antigravity',
      { HOME: home },
      HOST_SHELL
    )
    expect(workspaceTrustWritten(home, 'antigravity')).toBe(false)
  })

  it.each([
    ['no request', () => undefined, 'claude'],
    ['a malformed request', () => ({ workspacePath: 42 }), 'claude'],
    ['an earlier-shaped request', () => ({ worktreeRoot: workspace, trusted: true }), 'codex'],
    ['an agent with no trust preset', () => ({ workspacePath: workspace }), 'gemini'],
    ['no declared agent', () => ({ workspacePath: workspace }), undefined]
  ] as const)('writes nothing, so the agent asks, for %s', async (_label, request, agent) => {
    await applyRelayAgentWorkspaceTrust(request(), agent, { HOME: home }, HOST_SHELL)
    expect(nothingWritten()).toBe(true)
  })

  it('never fails the spawn when a writer throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const codexHome = join(root, 'codex-home')
    // Why: a config.toml that cannot be read as a file makes the Codex writer throw.
    mkdirSync(join(codexHome, 'config.toml'), { recursive: true })
    await expect(
      applyRelayAgentWorkspaceTrust(
        { workspacePath: workspace },
        'codex',
        { HOME: home, CODEX_HOME: codexHome },
        HOST_SHELL
      )
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('buildSshPtySpawnRequest', () => {
  it('forwards the workspace to trust as an optional field an old relay ignores', () => {
    const request = buildSshPtySpawnRequest({
      options: {
        cols: 80,
        rows: 24,
        launchAgent: 'codex',
        agentWorkspaceTrust: { workspacePath: '/w' }
      },
      supportsCreateOperation: false
    })
    expect(request.agentWorkspaceTrust).toEqual({ workspacePath: '/w' })
    expect(request.launchAgent).toBe('codex')
    expect(
      buildSshPtySpawnRequest({ options: { cols: 80, rows: 24 }, supportsCreateOperation: false })
    ).not.toHaveProperty('agentWorkspaceTrust')
  })
})
