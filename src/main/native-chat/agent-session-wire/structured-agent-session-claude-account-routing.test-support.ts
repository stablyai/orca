import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-identity'
import {
  ClaudeProfileRouter,
  type ClaudeProfileRouterSettings
} from '../../claude-accounts/claude-profile-router'
import { installClaudeProfileRouter } from '../../claude-accounts/claude-profile-installed-router'
import { claudeProfileMarkerPath } from '../../claude-accounts/claude-profile-paths'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/structured/claude-structured-agent-definition'
import { claudeInitializationAuthError } from '../../claude/structured/claude-structured-init-proof'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import { resolveStructuredClaudeAccountHomePath } from '../../runtime/structured-agent-account-home'
import { createClaudeStructuredLaunchResolver } from '../../runtime/structured-agent-launch-composition.test-support'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

const savedAccount = (id: string) => ({
  id,
  email: `${id}@example.test`,
  authMethod: 'subscription-oauth' as const,
  managedAuthPath: '/unused',
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0
})

const home = (path: string) => agentSessionAccountHome(CLAUDE_STRUCTURED_AGENT, path)

/** The real Claude account router, desired-home read and launch resolution, with accounts a and b
 *  saved and a selected; only what the Claude CLI finds in a folder is scripted. */
export function createClaudeAccountRouting() {
  let router: ClaudeProfileRouter | undefined
  const settings: ClaudeProfileRouterSettings = {
    claudeManagedAccounts: [savedAccount('a'), savedAccount('b')],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: undefined,
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  // The production resolver hop: only dispatch identity skips the availability check.
  const launchAccountHome: NonNullable<
    StructuredAgentSessionHostDeps['launchAccountHome']
  > = async (_record, purpose) =>
    home(
      await resolveStructuredClaudeAccountHomePath({
        launchEnv: {},
        wslDistro: null,
        ...(purpose === 'identity' ? { purpose } : {}),
        getClaudeConfigDirectory: () => router?.systemDefaultHome() ?? ''
      })
    )

  const install = (
    root: string,
    store: () => Pick<AgentSessionRecordStore, 'getRecord' | 'pinLaunchDirectory'>
  ) => {
    const installed = new ClaudeProfileRouter({
      getSettings: () => settings,
      dataRoot: root,
      userHome: join(root, 'personal'),
      env: {},
      runSetup: async ({ profile }) => {
        mkdirSync(profile.home, { recursive: true })
        writeFileSync(claudeProfileMarkerPath(profile), '{}')
        return { outcome: 'prepared', warnings: [], surfaces: {} }
      }
    })
    router = installed
    installClaudeProfileRouter(installed)
    const homeA = home(installed.accountHome('a'))
    const homeB = home(installed.accountHome('b'))
    const systemHome = home(installed.systemDefaultHome())
    for (const { path } of [homeA, homeB, systemHome]) {
      mkdirSync(path, { recursive: true })
    }
    // What the scripted Claude CLI finds in each folder it is launched under.
    const signedOut = new Set<string>()
    const transcripts = new Set<string>()
    const launches: string[] = []
    const resolveLaunch = createClaudeStructuredLaunchResolver({
      store: {
        getRecord: (id) => store().getRecord(id),
        pinLaunchDirectory: (id, directory) => store().pinLaunchDirectory(id, directory)
      },
      resolveLaunchArgs: () => [],
      resolveCommand: () => ({ command: '/usr/local/bin/claude', prefixArgs: [] }),
      resolveInheritedEnv: async () => ({ PATH: '/usr/bin' }),
      resolveAuthPolicy: () => ({ account: 'system' }),
      hasTranscript: async ({ claudeConfigDir }) => transcripts.has(claudeConfigDir)
    })
    return {
      homeA,
      homeB,
      systemHome,
      signedOut,
      transcripts,
      /** The folder each started Claude process ran under, in order. */
      launches,
      /** Resolve the launch as the Claude adapter's acquisition does, then start the scripted CLI. */
      launch: async (input: { identity: AgentSessionJournalIdentity; spawnToken: string }) => {
        const launch = await resolveLaunch(input)
        launches.push(launch.claudeConfigDir)
        if (signedOut.has(launch.claudeConfigDir)) {
          // The init frame a signed-out Claude CLI reports.
          throw claudeInitializationAuthError({ account: { tokenSource: 'none' } }, launch.account)
        }
        return {
          accountHome: home(launch.claudeConfigDir),
          ...(launch.accountRecipe ? { accountRecipe: launch.accountRecipe } : {})
        }
      },
      /** Switch the selected Claude account; null is System default. */
      select: (account: 'a' | 'b' | null) => {
        settings.activeClaudeManagedAccountId = account
      },
      accounts: () => settings.claudeManagedAccounts.map((account) => account.id),
      removeAccount: (account: 'a' | 'b') => {
        settings.claudeManagedAccounts = settings.claudeManagedAccounts.filter(
          (saved) => saved.id !== account
        )
      },
      uninstall: () => installClaudeProfileRouter(undefined)
    }
  }
  return { launchAccountHome, install }
}
