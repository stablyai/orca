import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV
} from '../../../../shared/agent-accounts/claude/claude-profile-routing'
import type { ClaudeEnvPatch } from '../../runtime-auth/environment'
import type { ClaudeRuntimeAuthPreparation } from '../../runtime-auth/runtime-auth-types'
import {
  claudeChosenAccountUnknown,
  claudeChosenAccountUnsupported
} from './claude-profile-launch-errors'
import type { ClaudeProfileRouter } from './claude-profile-router'
import { prepareClaudeProfileForLaunch } from './claude-profile-launch-preparation'
import { readUserClaudeConfigDirAsSet, type ClaudeProfileDescriptor } from '../claude-profile-paths'
import type { ClaudeProfileSetupReport } from '../setup/claude-profile-setup'

type ChosenLaunchRouter = Pick<
  ClaudeProfileRouter,
  'savedAccount' | 'accountLogin' | 'coveredBySystemDefault' | 'systemDefaultHome' | 'accountHome'
>

/** What only the router can lend: its login shell env and its per-account setup. */
type ChosenLaunchSetup = {
  envReady: Promise<unknown>
  env: () => NodeJS.ProcessEnv
  profile: (accountId: string) => ClaudeProfileDescriptor
  setUp: (profile: ClaudeProfileDescriptor) => Promise<ClaudeProfileSetupReport>
}

/** Why refuse, not fall back: the selected account would run a launch chosen for another one. */
export async function prepareChosenClaudeLaunch(
  router: ChosenLaunchRouter,
  accountId: string,
  setup: ChosenLaunchSetup
): Promise<ClaudeRuntimeAuthPreparation> {
  const saved = router.savedAccount(accountId)
  if (!saved) {
    throw claudeChosenAccountUnknown()
  }
  if (saved.managedAuthRuntime === 'wsl') {
    throw claudeChosenAccountUnsupported()
  }
  // As prepareLaunch: without its own login, coverage depends on the login shell's env.
  if (!router.accountLogin(accountId)) {
    await setup.envReady
  }
  const home = router.accountHome(accountId)
  if (router.coveredBySystemDefault(accountId)) {
    // Claude keys its login by the literal string, so the user's own value, unresolved.
    const own = readUserClaudeConfigDirAsSet(setup.env())
    const pointer = await writeLaunchPointer(home, '')
    return {
      ...hostPreparation(router.systemDefaultHome(), {
        [CLAUDE_PROFILE_POINTER_ENV]: pointer,
        ...(own ? { CLAUDE_CONFIG_DIR: own } : {})
      }),
      provenance: 'system'
    }
  }
  await prepareClaudeProfileForLaunch(setup.profile(accountId), setup.setUp)
  const pointer = await writeLaunchPointer(home, home)
  return {
    ...hostPreparation(home, {
      [CLAUDE_PROFILE_POINTER_ENV]: pointer,
      CLAUDE_CONFIG_DIR: home,
      [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home
    }),
    provenance: `profile:${accountId}`,
    readingAccount: { accountId, runtime: 'host', wslDistro: null }
  }
}

/** Why in the account's folder: removing the account removes the pointer its panes re-read. */
async function writeLaunchPointer(accountHome: string, target: string): Promise<string> {
  const pointer = join(dirname(accountHome), 'launch-pointer')
  if ((await readFile(pointer, 'utf8').catch(() => null)) !== target) {
    await mkdir(dirname(pointer), { recursive: true, mode: 0o700 })
    const staged = `${pointer}.${randomUUID()}.tmp`
    await writeFile(staged, target, { mode: 0o600 })
    await rename(staged, pointer)
  }
  return pointer
}

function hostPreparation(
  configDir: string,
  envPatch: ClaudeEnvPatch
): Omit<ClaudeRuntimeAuthPreparation, 'provenance'> {
  return { configDir, runtime: 'host', wslDistro: null, wslLinuxConfigDir: null, envPatch }
}
