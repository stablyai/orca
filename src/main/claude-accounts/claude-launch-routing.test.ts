import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { resolveClaudeStructuredInvocation } from '../claude/claude-structured-launch-resolution'
import { resolveClaudeStructuredLaunchHome } from '../claude/claude-structured-launch-home'
import { resolveStructuredClaudeAccountHomePath } from '../runtime/structured-agent-account-home'
import {
  installClaudeProfileRouter,
  withClaudeProfileTerminalEnv
} from './claude-profile-installed-router'
import { ClaudeProfileRouter, type ClaudeProfileRouterSettings } from './claude-profile-router'
import { prepareLocalCommitMessageAgentEnv } from '../text-generation/commit-message-agent-environment'
import { claudeStructuredAuthPolicyForSettings } from './claude-structured-auth-policy'
import { applyClaudeEnvPatch } from './environment'

const roots: string[] = []
afterEach(() => {
  installClaudeProfileRouter(undefined)
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function signIn(stateDir: string, email: string): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    join(stateDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } })
  )
}

/** Account a is selected and set up but signed in only in System default. */
function coveredAccount() {
  const root = mkdtempSync(join(tmpdir(), 'claude-launch-routing-'))
  roots.push(root)
  const userHome = join(root, 'personal')
  const dataRoot = join(root, 'data')
  const account: ClaudeManagedAccount = {
    id: 'a',
    email: 'a@example.test',
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused-legacy',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
  const settings: ClaudeProfileRouterSettings = {
    claudeManagedAccounts: [account],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: undefined,
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot,
    userHome,
    env: {},
    runSetup: async () => ({ outcome: 'prepared', warnings: [], surfaces: {} })
  })
  const accountHome = router.accountHome('a')
  mkdirSync(accountHome, { recursive: true })
  writeFileSync(join(accountHome, '..', 'profile.json'), '{}')
  signIn(userHome, 'a@example.test')
  installClaudeProfileRouter(router)
  return { router, settings, accountHome, systemHome: join(userHome, '.claude') }
}

/** Where every Orca-started Claude would run right now, read through each entry point. */
async function launchHomes(f: ReturnType<typeof coveredAccount>) {
  const chatEnv: Record<string, string> = {}
  return {
    terminal: (await f.router.prepareLaunch()).configDir,
    terminalEnv: withClaudeProfileTerminalEnv<Record<string, string>>({}, null, {
      runtime: 'host'
    }).CLAUDE_CONFIG_DIR,
    chat: await resolveClaudeStructuredLaunchHome(f.router, chatEnv, '/recorded'),
    chatEnv: chatEnv.CLAUDE_CONFIG_DIR,
    chatRecord: resolveStructuredClaudeAccountHomePath({
      launchEnv: {},
      wslDistro: null,
      getClaudeConfigDirectory: () => f.router.systemDefaultHome()
    }),
    chatAuth: claudeStructuredAuthPolicyForSettings(f.settings),
    usage: f.router.preparation().configDir,
    inactiveUsage: f.router.accountUsagePreparation('a').configDir
  }
}

const mainRoot = join(__dirname, '..')

function mainSourceFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (
        entry.name.endsWith('.ts') &&
        !/\.test\.|test-(?:support|fixture|harness)/.test(entry.name)
      ) {
        files.push(relative(mainRoot, path).split('\\').join('/'))
      }
    }
  }
  walk(mainRoot)
  return files
}

describe('one router decision for every Claude launch', () => {
  it('sends every entry point to System default, then to the account once it signs in', async () => {
    const f = coveredAccount()
    expect(await launchHomes(f)).toEqual({
      terminal: f.systemHome,
      terminalEnv: undefined,
      chat: f.systemHome,
      chatEnv: undefined,
      chatRecord: f.systemHome,
      chatAuth: { account: 'system' },
      usage: f.systemHome,
      inactiveUsage: f.systemHome
    })
    signIn(f.accountHome, 'a@example.test')
    expect(await launchHomes(f)).toEqual({
      terminal: f.accountHome,
      terminalEnv: f.accountHome,
      chat: f.accountHome,
      chatEnv: f.accountHome,
      chatRecord: f.accountHome,
      // A shell proxy's key stays with its address on the account too.
      chatAuth: { account: 'managed' },
      usage: f.accountHome,
      inactiveUsage: f.accountHome
    })
  })

  // The shell function's half is in claude-shell-function.test.ts; WSL's in the WSL router test.
  it.each(['signed-in account', 'System default fallback'])(
    "keeps a shell proxy's key with its address on every launch: %s",
    async (scenario) => {
      const f = coveredAccount()
      if (scenario === 'signed-in account') {
        signIn(f.accountHome, 'a@example.test')
      }
      const home = scenario === 'signed-in account' ? f.accountHome : undefined
      const shell = {
        ANTHROPIC_BASE_URL: 'https://proxy.example.test',
        ANTHROPIC_API_KEY: 'proxy-key',
        ANTHROPIC_AUTH_TOKEN: 'proxy-token'
      }
      // A terminal applies the launch's patch to its own env and deletes nothing more.
      const terminal = applyClaudeEnvPatch(
        { PATH: '/usr/bin', ...shell },
        (await f.router.prepareLaunch()).envPatch
      )
      expect(terminal).toMatchObject(shell)
      expect(terminal.CLAUDE_CONFIG_DIR).toBe(home)
      const chat = await resolveClaudeStructuredInvocation({
        resolveCommand: () => 'claude',
        resolveInheritedEnv: async () => ({ PATH: '/usr/bin', ...shell }),
        resolveAuthPolicy: () => claudeStructuredAuthPolicyForSettings(f.settings)
      })
      expect(chat.env).toMatchObject(shell)
      const saved = Object.fromEntries(Object.keys(shell).map((key) => [key, process.env[key]]))
      Object.assign(process.env, shell)
      try {
        const commit = await prepareLocalCommitMessageAgentEnv('claude', {
          prepareForClaudeLaunch: () => f.router.prepareLaunch()
        })
        expect(commit).toMatchObject({ ok: true, env: shell })
        if (home) {
          expect(commit.ok && commit.env?.CLAUDE_CONFIG_DIR).toBe(home)
        }
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }
    }
  )

  // Terminals, chats, AI commit messages and automations launch through
  // ClaudeRuntimeAuthService.prepareForClaudeLaunch; usage through prepareForRateLimitFetch.
  it('keeps the Claude selection and account folders out of every launch path but the router', () => {
    const routing =
      /\b(?:getSelectedClaudeAccountIdForTarget|activeClaudeManagedAccountIds?(?:ByRuntime)?|describeClaudeProfile|wslClaudeProfile|isHostManagedClaudeAccount)\b|\.accountHome\(/
    // Both map settings keys to model-catalog expiry or prewarm; they route nothing.
    const allowed = new Set([
      'native-chat/agent-model-catalog/agent-model-catalog-account-expiry.ts',
      'startup/main-process-account-services.ts'
    ])
    const files = mainSourceFiles()
    // Presence: the scan reaches the router, and the pattern finds what the router reads.
    expect(files).toContain('claude-accounts/claude-profile-router.ts')
    expect(
      readFileSync(join(mainRoot, 'claude-accounts/claude-profile-router.ts'), 'utf8')
    ).toMatch(routing)
    const bypassing = files.filter(
      (file) =>
        !file.startsWith('claude-accounts/') &&
        !allowed.has(file) &&
        routing.test(readFileSync(join(mainRoot, file), 'utf8'))
    )
    expect(bypassing).toEqual([])
  })

  // Terminals and AI commit messages run `claude` by agent id through generic launchers, which call
  // prepareForClaudeLaunch for it; a new generic launcher is covered by the entry-point test above.
  it('lets only router-aware modules resolve the claude binary or load the Agent SDK', () => {
    const spawning = /\bresolveClaudeCommand\b|\bloadClaudeAgentSdk\b/
    const reviewed: Record<string, string> = {
      'claude/claude-structured-child-env.ts':
        'chat child; its home comes from router.prepareLaunch',
      'claude/claude-stream-json-connection.ts': 'spawns the chat child with that launch env',
      'claude-accounts/claude-profile-router.ts': 'the router: a `--version` probe only',
      'claude-accounts/claude-command-process.ts': 'sign-in into a named account folder',
      'runtime/structured-claude-runtime-adapter.ts': 'wires the routed chat resolver',
      'runtime/structured-agent-session-runtime.ts': 'passes the resolver through',
      'runtime/structured-agent-runtime-registrations.ts': 'passes the resolver through',
      'runtime/structured-agent-model-catalog-discovery.ts': 'model listing on the routed chat env',
      'runtime/orca-runtime-get-worktree-ps.ts': 'wires the routed chat resolver'
    }
    const found = mainSourceFiles().filter((file) =>
      spawning.test(readFileSync(join(mainRoot, file), 'utf8'))
    )
    // Reach: every reviewed module still exists and still matches, so the list cannot rot quietly.
    expect(found.filter((file) => file in reviewed).sort()).toEqual(Object.keys(reviewed).sort())
    expect(found.filter((file) => !(file in reviewed))).toEqual([])
  })
})
