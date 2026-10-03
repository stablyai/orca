import type * as ProfileRouting from '../../shared/claude-profile-routing'
import type * as Os from 'node:os'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeProfileRoutingService } from './claude-profile-routing-service'
const state = vi.hoisted<{ routing: ClaudeProfileRoutingService | undefined }>(() => ({
  routing: undefined
}))
const fakeHome = vi.hoisted(
  () => `${(process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')}/orca-consumers-no-home`
)
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => fakeHome
}))
vi.mock('./claude-profile-routing-authority', () => ({
  getClaudeProfileRoutingAuthority: () => state.routing
}))
vi.mock('../../shared/claude-profile-routing', async (original) => ({
  ...(await original<typeof ProfileRouting>()),
  claudeProfileRoutingEnabled: () => true
}))
import { createNativeClaudeProfileRouting } from './claude-profile-native-owner'
import { describeClaudeProfile, prepareClaudeProfileDirectory } from './claude-profile-paths'
import { provisionClaudeAccountProfile } from './claude-profile-setup'
import { resolveStructuredClaudeAccountHomePath } from '../runtime/structured-agent-account-home'
import { createClaudeStructuredLaunchResolver } from '../claude/claude-structured-launch-resolution'
import {
  createClaudeModelCatalogProbe,
  type ClaudeModelCatalogProbeDeps
} from '../claude/claude-model-catalog-probe'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { claudeProjectsRootDirs } from '../ai-vault/session-scanner-roots'
import {
  claudeTranscriptScanRoots,
  listClaudeTranscriptFiles
} from '../claude-usage/transcript-file-discovery'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { resolveSkillProviderRoots } from '../runtime/runtime-skill-install-authority'
import { applyAgentWorkspaceTrust } from '../agent-workspace-trust'
import { discoverRetiredWorktreeNames } from '../worktree-retirement-discovery'
import { discoverSkills } from '../skills/discovery'
import { prepareLocalCommitMessageAgentEnv } from '../text-generation/commit-message-agent-environment'
import { MARINE_CREATURES } from '../../shared/marine-creatures'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'

const roots: string[] = []
afterEach(() => {
  state.routing = undefined
  vi.unstubAllEnvs()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'profile-consumers-'))
  roots.push(root)
  const home = join(root, 'personal')
  const dataRoot = join(root, 'data')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(dataRoot)
  const accounts: ClaudeManagedAccount[] = ['a', 'b'].map((id) => ({
    id,
    email: `${id}@example.test`,
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }))
  const settings: {
    claudeManagedAccounts: ClaudeManagedAccount[]
    activeClaudeManagedAccountId: string | null
  } = {
    claudeManagedAccounts: accounts,
    activeClaudeManagedAccountId: 'b'
  }
  const profiles = ['a', 'b'].map((id) =>
    describeClaudeProfile(dataRoot, id, { runtime: 'host', executionHostId: 'local' })
  )
  profiles.forEach((profile) => {
    prepareClaudeProfileDirectory(dataRoot, profile, home)
    writeFileSync(
      join(profile.home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: `${profile.accountId}@example.test` } })
    )
  })
  const worker = {
    prepare: vi.fn(async (job: Parameters<typeof provisionClaudeAccountProfile>[0]) =>
      provisionClaudeAccountProfile(job)
    )
  }
  const routing = createNativeClaudeProfileRouting({
    store: {
      getSettings: () => ({ ...settings, agentStatusHooksEnabled: true, disabledTuiAgents: [] })
    },
    dataRoot,
    userHome: home,
    inheritedConfigDir: () => null,
    claudeVersion: async () => '2.1.261',
    worker: { prepare: async (job) => worker.prepare({ ...job, installHooks: null }) }
  })
  state.routing = routing
  return { root, home, dataRoot, profiles, settings, routing, worker }
}
describe('Claude profile consumers', () => {
  it('resolves structured records through selection instead of inherited configuration', () => {
    const f = fixture()
    const home = resolveStructuredClaudeAccountHomePath({
      launchEnv: { CLAUDE_CONFIG_DIR: '/wrong-account' },
      wslDistro: null,
      getClaudeConfigDirectory: () => null
    })
    expect(home).toBe(f.profiles[1].home)
    f.settings.activeClaudeManagedAccountId = null
    expect(
      resolveStructuredClaudeAccountHomePath({
        launchEnv: { CLAUDE_CONFIG_DIR: '/user-own-claude' },
        wslDistro: null,
        getClaudeConfigDirectory: () => null
      })
    ).toBe('/user-own-claude')
    f.settings.activeClaudeManagedAccountId = 'b'
    expect(() =>
      resolveStructuredClaudeAccountHomePath({
        launchEnv: {},
        wslDistro: 'Ubuntu',
        getClaudeConfigDirectory: () => null
      })
    ).toThrow('WSL')
  })
  it('a new structured child selects B while retaining A as history origin', async () => {
    const f = fixture()
    let record = agentSessionRecordFixture()
    record = {
      ...record,
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: f.profiles[0].home },
      providerHandleChain: []
    }
    const resolver = createClaudeStructuredLaunchResolver({
      store: {
        getRecord: () => record,
        transitionHandoff: async (_id, apply) => {
          record = apply(record)
          return record
        }
      },
      resolveWorkspacePath: async () => f.root,
      resolveCommand: () => '/fake/claude',
      resolveInheritedEnv: async () => ({ ANTHROPIC_API_KEY: 'fake-inherited' }),
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      hasTranscript: async () => true
    })
    const pendingLaunch = resolver({
      identity: {
        sessionId: record.sessionId,
        workspaceId: record.location.workspaceId,
        hostId: 'local',
        agent: 'claude',
        providerHandle: { kind: 'claude', sessionId: 'fake-session', leafUuid: null }
      }
    })
    await expect(pendingLaunch).resolves.toMatchObject({ claudeConfigDir: f.profiles[1].home })
    const launch = await pendingLaunch
    expect(launch.claudeConfigDir).toBe(f.profiles[1].home)
    expect(launch.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(record.accountHome.path).toBe(f.profiles[0].home)
    expect(record.launchAccountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: f.profiles[1].home,
      accountId: 'b'
    })
  })
  it('System Default launches and probes under the Claude agent env’s own config dir', async () => {
    const f = fixture()
    f.settings.activeClaudeManagedAccountId = null
    const userOwn = join(f.root, 'user-own-claude')
    const resolveEnv = () => ({ CLAUDE_CONFIG_DIR: userOwn })
    const created = resolveStructuredClaudeAccountHomePath({
      launchEnv: resolveEnv(),
      wslDistro: null,
      getClaudeConfigDirectory: () => null
    })
    let record: AgentSessionRecord = {
      ...agentSessionRecordFixture(),
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: created },
      providerHandleChain: []
    }
    const launch = await createClaudeStructuredLaunchResolver({
      store: {
        getRecord: () => record,
        transitionHandoff: async (_id, apply) => {
          record = apply(record)
          return record
        }
      },
      resolveWorkspacePath: async () => f.root,
      resolveCommand: () => '/fake/claude',
      resolveEnv,
      resolveInheritedEnv: async () => ({}),
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      hasTranscript: async () => true
    })({
      identity: {
        sessionId: record.sessionId,
        workspaceId: record.location.workspaceId,
        hostId: 'local',
        agent: 'claude',
        providerHandle: { kind: 'claude', sessionId: 'fake-session', leafUuid: null }
      }
    })
    expect(launch.claudeConfigDir).toBe(userOwn)
    expect(launch.env?.CLAUDE_CONFIG_DIR).toBe(userOwn)
    expect(record.launchAccountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: userOwn,
      accountId: null
    })
    const discover = vi.fn(async () => ({ success: false as const, error: 'fake listing' }))
    const probe = createClaudeModelCatalogProbe({
      resolveCommand: () => '/fake/claude',
      resolveEnv,
      resolveInheritedEnv: async () => ({}),
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      discover
    })
    await expect(probe(userOwn)).rejects.toThrow('fake listing')
    await expect(probe(f.profiles[0].home)).rejects.toThrow('Inactive')
  })
  it('refuses inactive model probes and pins a selected probe to its cache home', async () => {
    const f = fixture()
    const discover = vi.fn(
      async (input: Parameters<NonNullable<ClaudeModelCatalogProbeDeps['discover']>>[0]) => {
        expect(input.env?.CLAUDE_CONFIG_DIR).toBe(f.profiles[1].home)
        return {
          success: true as const,
          catalogOrigin: 'probe' as const,
          models: [{ id: 'fake', label: 'Fake' }],
          capability: {
            id: 'claude' as const,
            label: 'Claude',
            modelSource: 'dynamic' as const,
            defaultModelId: 'fake',
            models: []
          },
          defaultModelId: 'fake'
        }
      }
    )
    const probe = createClaudeModelCatalogProbe({
      resolveCommand: () => '/fake/claude',
      resolveInheritedEnv: async () => ({}),
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      discover
    })
    await expect(probe(f.profiles[0].home)).rejects.toThrow('Inactive')
    expect(discover).not.toHaveBeenCalled()
    await expect(probe(f.profiles[1].home)).resolves.toMatchObject({ origin: 'probe' })
  })
  it('global skills stay personal and are immediately visible through profile links', async () => {
    const f = fixture()
    mkdirSync(join(f.home, '.claude', 'skills'))
    await f.routing.prepare()
    const roots = await resolveSkillProviderRoots(
      { getClaudeConfigDirectory: () => f.profiles[1].home },
      { scope: 'global', homeDirectory: f.home }
    )
    expect(roots.claude).toBe(join(f.home, '.claude', 'skills'))
    writeFileSync(join(roots.claude!, 'fake-skill'), 'installed')
    expect(readFileSync(join(f.profiles[1].home, 'skills', 'fake-skill'), 'utf8')).toBe('installed')
    f.settings.activeClaudeManagedAccountId = null
    const systemDefault = await resolveSkillProviderRoots(
      { getClaudeConfigDirectory: () => '/user-own-claude' },
      { scope: 'global', homeDirectory: f.home }
    )
    expect(systemDefault.claude).toBe(join('/user-own-claude', 'skills'))
  })
  it('skill discovery keeps a caller’s Claude root and survives an unresolvable selection', async () => {
    const f = fixture()
    vi.stubEnv('HERMES_HOME', join(f.root, 'hermes'))
    const personal = join(f.home, '.claude', 'skills')
    for (const dir of [
      join(personal, 'fake-skill'),
      join(f.home, '.codex', 'skills', 'codex-skill')
    ]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${basename(dir)}\ndescription: Fake\n---\n`)
    }
    await f.routing.prepare()
    const scan = (providerRootOverrides: { claude?: string }) =>
      discoverSkills({
        homeDir: f.home,
        repos: [],
        includeCwd: false,
        refresh: true,
        providerRootOverrides
      })
    const explicit = await scan({ claude: personal })
    expect(explicit.skills.find((skill) => skill.name === 'fake-skill')?.directoryPath).toBe(
      join(personal, 'fake-skill')
    )
    rmSync(join(f.dataRoot, 'claude-profiles', 'b', 'profile.json'))
    const names = (await scan({})).skills.map((skill) => skill.name)
    expect(names).toEqual(expect.arrayContaining(['codex-skill', 'fake-skill']))
  })
  it('pre-trust writes the launch env’s profile config within the legacy guard, without setup', async () => {
    const f = fixture()
    const config = join(f.profiles[1].home, '.claude.json')
    writeFileSync(config, JSON.stringify({ oauthAccount: { fake: 'private-b' } }))
    const cwd = join(f.root, 'workspace')
    mkdirSync(cwd)
    const launch = (workspace: string) =>
      applyAgentWorkspaceTrust('claude', workspace, {
        connectionId: null,
        wslDistro: null,
        env: { HOME: f.home, ...f.routing.terminalEnv() },
        claudeAuth: null
      })
    await launch(cwd)
    const result = JSON.parse(readFileSync(config, 'utf8'))
    expect(result.oauthAccount).toEqual({ fake: 'private-b' })
    expect(result.projects).toEqual(expect.objectContaining({ [cwd]: expect.any(Object) }))
    expect(f.worker.prepare).not.toHaveBeenCalled()
    const homeLink = join(f.root, 'home-link')
    symlinkSync(f.home, homeLink, 'dir')
    await launch(homeLink)
    expect(JSON.parse(readFileSync(config, 'utf8')).projects).toEqual(result.projects)
  })
  it('commit generation uses the same captured profile and retirement includes private history', async () => {
    const f = fixture()
    const result = await prepareLocalCommitMessageAgentEnv('claude', {
      prepareForClaudeLaunch: () => f.routing.prepare()
    })
    expect(result).toMatchObject({ ok: true, env: { CLAUDE_CONFIG_DIR: f.profiles[1].home } })
    f.settings.activeClaudeManagedAccountId = null
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/user-own-claude')
    await expect(
      prepareLocalCommitMessageAgentEnv('claude', {
        prepareForClaudeLaunch: () => f.routing.prepare()
      })
    ).resolves.toMatchObject({ ok: true, env: { CLAUDE_CONFIG_DIR: '/user-own-claude' } })
    const parent = join(f.root, 'workspaces')
    mkdirSync(parent)
    const retired = MARINE_CREATURES[0].toLowerCase()
    const bucket = `${parent.replace(/[^a-zA-Z0-9]/g, '-')}-${retired}`
    mkdirSync(join(f.profiles[0].home, 'projects', bucket), { recursive: true })
    const names = await discoverRetiredWorktreeNames({
      workspaceRoots: [parent],
      home: f.home,
      env: {}
    })
    expect(names.names.has(retired)).toBe(true)
  })
  it('Vault and transcript discovery include private homes, deduplicate shared roots and reject arbitrary links', async () => {
    const f = fixture()
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    const shared = join(f.home, '.claude', 'projects')
    const privateProjects = join(f.profiles[0].home, 'projects')
    mkdirSync(shared)
    mkdirSync(join(privateProjects, 'cwd'), { recursive: true })
    symlinkSync(shared, join(f.profiles[1].home, 'projects'), 'dir')
    const transcript = join(privateProjects, 'cwd', 'private-session.jsonl')
    writeFileSync(transcript, '{}\n')
    const roots = claudeProjectsRootDirs({ claudeProjectsDir: shared })
    expect(roots).toContain(privateProjects)
    expect(roots).not.toContain(join(f.profiles[1].home, 'projects'))
    const scanRoots = claudeTranscriptScanRoots()
    expect(
      scanRoots.filter((root) => !root.startsWith(fakeHome) && !root.startsWith(f.root))
    ).toEqual([])
    expect(await listClaudeTranscriptFiles(scanRoots)).toContain(transcript)
    expect(await resolveSessionFilePath('claude', 'private-session')).toBe(transcript)
    rmSync(join(f.profiles[1].home, 'projects'))
    symlinkSync(f.root, join(f.profiles[1].home, 'projects'), 'dir')
    expect(claudeProjectsRootDirs({ claudeProjectsDir: shared })).not.toContain(
      join(f.profiles[1].home, 'projects')
    )
  })
})
