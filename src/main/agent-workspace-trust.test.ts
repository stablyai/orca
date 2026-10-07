import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaudeFolderTrustFile from './claude/claude-folder-trust-file'

const CODEX_CONFIG_FILES = ['/orca/codex-home/config.toml', '/home/u/.codex/config.toml']

const mocks = vi.hoisted(() => ({
  codex: vi.fn<(path: string, configFiles: readonly string[]) => Promise<void>>(async () => {}),
  cursor: vi.fn<(path: string, home: string) => void>(),
  copilot: vi.fn<(path: string, home: string) => void>(),
  antigravity: vi.fn<(path: string, home: string) => void>(),
  qoder: vi.fn<(path: string, home: string) => void>(),
  codexConfigFiles: vi.fn<(launchedConfigFile: string) => string[]>(() => CODEX_CONFIG_FILES),
  claudeGrant: vi.fn<typeof ClaudeFolderTrustFile.grantClaudeWorkspaceTrust>()
}))

vi.mock('./agent-trust-presets', () => ({
  markCodexProjectTrusted: mocks.codex,
  markCursorWorkspaceTrusted: mocks.cursor,
  markCopilotFolderTrusted: mocks.copilot,
  markAntigravityWorkspaceTrusted: mocks.antigravity
}))
vi.mock('./codex/codex-home-paths', () => ({
  getLocalCodexTrustConfigFiles: mocks.codexConfigFiles
}))
vi.mock('./qoder/workspace-trust', () => ({ markQoderWorkspaceTrusted: mocks.qoder }))
vi.mock('./claude/claude-folder-trust-file', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeFolderTrustFile>()
  mocks.claudeGrant.mockImplementation(actual.grantClaudeWorkspaceTrust)
  return { ...actual, grantClaudeWorkspaceTrust: mocks.claudeGrant }
})

import { applyAgentWorkspaceTrust, type AgentTrustLaunchContext } from './agent-workspace-trust'
import { clearWslHomeCache, rememberWslHome } from './wsl-home-cache'
import {
  AGENT_TRUST_WRITE_DEADLINE_MS,
  SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
} from './agent-trust-write-deadline'

const WORKSPACE = '/workspace/app'
const local: AgentTrustLaunchContext = {
  env: {},
  claudeAuth: null,
  wslDistro: null,
  connectionId: null,
  codexHome: null
}

function pending(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('applyAgentWorkspaceTrust on this machine', () => {
  it.each([
    ['codex', mocks.codex],
    ['cursor', mocks.cursor],
    ['copilot', mocks.copilot],
    ['qoder', mocks.qoder],
    // Why: one of the old copied switches omitted Antigravity, so workers launched there asked.
    ['antigravity', mocks.antigravity]
  ] as const)('writes the %s preset for the workspace', async (preset, writer) => {
    await expect(applyAgentWorkspaceTrust(preset, WORKSPACE, local)).resolves.toEqual({})
    expect(writer).toHaveBeenCalledWith(
      WORKSPACE,
      preset === 'codex' ? CODEX_CONFIG_FILES : homedir()
    )
  })

  it('writes per-user trust under the home the launch env names, where the agent reads it', async () => {
    const context = { ...local, env: { HOME: '/home/agent', USERPROFILE: '/home/agent' } }
    for (const preset of ['cursor', 'copilot', 'qoder', 'antigravity'] as const) {
      await applyAgentWorkspaceTrust(preset, WORKSPACE, context)
    }
    for (const writer of [mocks.cursor, mocks.copilot, mocks.qoder, mocks.antigravity]) {
      expect(writer).toHaveBeenCalledWith(WORKSPACE, '/home/agent')
    }
  })

  it.each([
    // Why: an explicit CODEX_HOME wins over whatever HOME the launch env names.
    ['the CODEX_HOME Orca gives the launch', '/orca/accounts/a/home', '/orca/accounts/a/home'],
    ['.codex under the launch env home without one', null, join('/home/agent', '.codex')]
  ])('writes Codex trust into %s', async (_label, codexHome, expectedHome) => {
    const context = {
      ...local,
      env: { HOME: '/home/agent', USERPROFILE: '/home/agent' },
      codexHome
    }
    await applyAgentWorkspaceTrust('codex', WORKSPACE, context)
    expect(mocks.codexConfigFiles).toHaveBeenCalledWith(join(expectedHome, 'config.toml'))
  })

  it('falls back to the home folder when the launch env names no home', async () => {
    await applyAgentWorkspaceTrust('codex', WORKSPACE, local)
    expect(mocks.codexConfigFiles).toHaveBeenCalledWith(join(homedir(), '.codex', 'config.toml'))
  })

  it('contains a rejected or throwing write so the launch proceeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.codex.mockRejectedValueOnce(new Error('write failed'))
    mocks.cursor.mockImplementationOnce(() => {
      throw new Error('write failed')
    })
    await expect(applyAgentWorkspaceTrust('codex', WORKSPACE, local)).resolves.toEqual({})
    await expect(applyAgentWorkspaceTrust('cursor', WORKSPACE, local)).resolves.toEqual({})
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('gives only Codex the long deadline its shared config lane needs', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const codexWrite = pending()
    mocks.codex.mockReturnValueOnce(codexWrite.promise)
    let codexSettled = false
    const codex = applyAgentWorkspaceTrust('codex', WORKSPACE, local).then(() => {
      codexSettled = true
    })
    await vi.advanceTimersByTimeAsync(SHORT_AGENT_TRUST_WRITE_DEADLINE_MS + 1)
    expect(codexSettled).toBe(false)
    await vi.advanceTimersByTimeAsync(AGENT_TRUST_WRITE_DEADLINE_MS)
    await codex
    expect(codexSettled).toBe(true)
    codexWrite.release()
    warn.mockRestore()
  })

  // Why: a config dir that does not exist keeps a regression here from writing a real config.
  const noConfig = { ...local, env: { CLAUDE_CONFIG_DIR: join(tmpdir(), 'orca-no-claude-config') } }
  it.each([
    ['the home folder', homedir(), noConfig],
    [
      'the home the spawn env names',
      '/home/agent',
      { ...noConfig, env: { ...noConfig.env, HOME: '/home/agent' } }
    ],
    ['a filesystem root', '/', noConfig],
    ['a drive root', 'C:\\', noConfig]
  ])(
    'never pre-trusts %s for an agent that inherits trust from it',
    async (_label, workspacePath, context) => {
      for (const preset of ['claude', 'copilot', 'qoder'] as const) {
        await expect(applyAgentWorkspaceTrust(preset, workspacePath, context)).resolves.toEqual({})
      }
      for (const writer of [mocks.copilot, mocks.qoder, mocks.claudeGrant]) {
        expect(writer).not.toHaveBeenCalled()
      }
    }
  )

  it('trusts the home folder for Codex, Cursor and Antigravity, whose trust there stays there', async () => {
    for (const preset of ['codex', 'cursor', 'antigravity'] as const) {
      await applyAgentWorkspaceTrust(preset, homedir(), noConfig)
    }
    expect(mocks.codex).toHaveBeenCalledWith(homedir(), CODEX_CONFIG_FILES)
    expect(mocks.cursor).toHaveBeenCalledWith(homedir(), homedir())
    expect(mocks.antigravity).toHaveBeenCalledWith(homedir(), homedir())
  })

  it('never pre-trusts a home reached through a symlink, since the writers store the realpath', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-agent-trust-home-')))
    try {
      const home = join(root, 'home')
      mkdirSync(home)
      symlinkSync(home, join(root, 'home-link'), 'junction')
      const cases = [
        [join(root, 'home-link'), home],
        [home, join(root, 'home-link')]
      ]
      for (const [workspacePath, homePath] of cases) {
        const context = { ...noConfig, env: { ...noConfig.env, HOME: homePath } }
        for (const preset of ['claude', 'copilot', 'qoder'] as const) {
          await applyAgentWorkspaceTrust(preset, workspacePath, context)
        }
      }
      for (const writer of [mocks.copilot, mocks.qoder, mocks.claudeGrant]) {
        expect(writer).not.toHaveBeenCalled()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['a WSL distro', { ...local, wslDistro: 'Ubuntu' }, WORKSPACE],
    ['a WSL UNC workspace', local, '\\\\wsl.localhost\\Ubuntu\\home\\u\\wt']
  ])('never writes the Windows home for %s', async (_label, context, workspacePath) => {
    for (const preset of ['codex', 'cursor', 'copilot', 'qoder', 'antigravity'] as const) {
      await applyAgentWorkspaceTrust(preset, workspacePath, context)
    }
    for (const writer of [mocks.codex, mocks.cursor, mocks.copilot, mocks.qoder]) {
      expect(writer).not.toHaveBeenCalled()
    }
    expect(mocks.antigravity).not.toHaveBeenCalled()
  })
  describe('for Claude in a WSL guest', () => {
    const wslAuth = {
      configDir: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.claude',
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      wslLinuxConfigDir: '/home/u/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'test'
    } as const
    const wsl = { ...local, claudeAuth: wslAuth, wslDistro: 'Ubuntu' }

    afterEach(() => {
      clearWslHomeCache()
    })

    it("writes nothing while the guest's home is unknown", async () => {
      await applyAgentWorkspaceTrust('claude', '\\\\wsl.localhost\\Ubuntu\\home\\u\\wt', wsl)
      expect(mocks.claudeGrant).not.toHaveBeenCalled()
    })

    it("never pre-trusts the guest's home, however the distro is spelled", async () => {
      rememberWslHome('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\u')
      await applyAgentWorkspaceTrust('claude', '\\\\wsl$\\ubuntu\\home\\u', wsl)
      expect(mocks.claudeGrant).not.toHaveBeenCalled()
    })

    it("grants a folder under the guest's known home", async () => {
      rememberWslHome('ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\u')
      mocks.claudeGrant.mockResolvedValueOnce('unchanged')
      await applyAgentWorkspaceTrust('claude', '\\\\wsl.localhost\\Ubuntu\\home\\u\\wt', wsl)
      expect(mocks.claudeGrant).toHaveBeenCalledTimes(1)
    })
  })
})

describe('applyAgentWorkspaceTrust for Claude', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-agent-trust-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
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

  it('gives a local Claude write a short budget, after which Claude asks', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const grant = pending()
    mocks.claudeGrant.mockReturnValueOnce(grant.promise.then(() => 'granted' as const))
    let settled = false
    const claude = applyAgentWorkspaceTrust('claude', root, {
      ...local,
      env: { CLAUDE_CONFIG_DIR: root }
    }).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(SHORT_AGENT_TRUST_WRITE_DEADLINE_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await claude
    expect(settled).toBe(true)
    expect(String(warn.mock.calls[0]?.[0])).toContain('did not settle')
    grant.release()
    warn.mockRestore()
  })

  it.each(['claude', 'codex', 'cursor', 'copilot', 'qoder', 'antigravity'] as const)(
    'hands an SSH %s launch to the relay instead of writing anything here',
    async (preset) => {
      await expect(
        applyAgentWorkspaceTrust(preset, '/srv/wt', { ...local, connectionId: 'ssh-1' })
      ).resolves.toEqual({ agentWorkspaceTrust: { workspacePath: '/srv/wt' } })
      for (const writer of [
        mocks.codex,
        mocks.cursor,
        mocks.copilot,
        mocks.qoder,
        mocks.antigravity,
        mocks.claudeGrant
      ]) {
        expect(writer).not.toHaveBeenCalled()
      }
    }
  )
})
