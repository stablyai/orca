import { credentialFileExists } from '../credentials/credential-file-io'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-status/process/agent-process-recognition'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { getAntigravityAccountService, getAntigravityAccountVaultPath } from './native-account-host'
import { AntigravityLaunchRestoreError } from './native-account-login-view'
import { AGY_HOST_SELECTION, type AgyPreparedLogin } from './agy-account-selection'
import {
  AgyForeignCredentialAuthority,
  agyLaunchIsForeign,
  assertHostCredentialAuthority
} from './agy-launch-credential-authority'
import { noteAgyTerminalAuthority } from './agy-terminal-authority'

/** The selected account ('' when none) agy's login was found or put on; undefined when this launch
 *  doesn't select one, null when `quiet` left the login unread. */
export async function prepareAntigravityAccountForLaunch(args: {
  launchAgent?: string
  command?: string
  connectionId?: string | null
  isWsl?: boolean
  env?: NodeJS.ProcessEnv
  envIsComplete?: boolean
  envToDelete?: readonly string[]
  /** False skips a restore that would read a login whose read could raise a keychain dialog. */
  mayPrompt?: boolean
  /** Nobody is waiting on this launch: never read a login only a keychain dialog could name. */
  quiet?: boolean
}): Promise<string | null | undefined> {
  const env = args.envIsComplete ? { ...args.env } : { ...process.env, ...args.env }
  for (const key of args.envToDelete ?? []) {
    delete env[key]
  }
  // Any host terminal may run agy later, typed in its shell: a switch reads who its login is.
  const paneKey = args.env?.ORCA_PANE_KEY
  if (paneKey && !args.connectionId && !args.isWsl) {
    noteAgyTerminalAuthority(paneKey, env, args.envToDelete)
  }
  // Windows account selection applies the host default; the shell and agent own each launch.
  if (process.platform === 'win32') {
    return undefined
  }
  const agent =
    args.launchAgent ??
    (args.command ? recognizeAgentProcessFromCommandLine(args.command)?.agent : null)
  // Client snapshots never select accounts for a relay or a client-selected distro.
  if (agent !== 'antigravity' || args.connectionId || args.isWsl) {
    return undefined
  }
  const path = getAntigravityAccountVaultPath()
  if (!(await credentialFileExists(path))) {
    return ''
  }
  if (!(await createEncryptedAntigravityAccountStore(path).read()).selectedAccountId) {
    return ''
  }
  await assertHostCredentialAuthority(env, { envToDelete: args.envToDelete ?? [] })
  return (await getAntigravityAccountService({ runtime: 'host' })).prepareForLaunch({
    mayPrompt: args.mayPrompt ?? true,
    quiet: args.quiet === true
  })
}

/** A login no fresh evidence names. */
const UNNAMED_LOGIN = '?'

/** Where a launch left agy's login: on the selected account, else on `holder`, the account fresh
 *  evidence names (null: none), with why it isn't the selected one. */
function agyPreparedLogin(
  selected: string,
  holder: string | null,
  failure: string
): AgyPreparedLogin {
  return holder === selected
    ? { key: selected, target: selected }
    : { key: holder ?? UNNAMED_LOGIN, target: selected, failure }
}

/** Only a failed restore of the host's own login names who holds it; any other failure names
 *  nobody. */
function agyLoginHolderAfter(error: unknown): string | null {
  return error instanceof AntigravityLaunchRestoreError ? error.holder : null
}

/** Where a launch that failed to reach the selected account left agy's login; one on another home
 *  or credential store is foreign: no saved account names it, so it never latches the selection. */
export function agyLoginAfterFailure(
  selected: string,
  error: unknown
): AgyPreparedLogin | { foreign: true } {
  if (error instanceof AgyForeignCredentialAuthority) {
    return { foreign: true }
  }
  const reason = error instanceof Error ? error.message : String(error)
  return agyPreparedLogin(selected, agyLoginHolderAfter(error), reason)
}

/** Windows puts no account back at launch, but reading its login there raises no dialog. */
async function windowsLaunchLogin(selected: string): Promise<AgyPreparedLogin> {
  if (!selected) {
    return { key: selected, target: selected }
  }
  const holder = await getAntigravityAccountService({ runtime: 'host' })
    .then((service) => service.readLoginHolder())
    .catch(() => null)
  return agyPreparedLogin(
    selected,
    holder,
    holder === null
      ? "Orca couldn't read agy's login."
      : 'agy is signed in to another account. Select the account again under Settings → Accounts.'
  )
}

/** A chat or listing puts the selected account back when that's safe and raises no keychain
 *  dialog, else starts on agy's current login as before; either way it says which account that is. */
export async function restoreSelectedAntigravityAccount(
  env: Readonly<Record<string, string>>
): Promise<AgyPreparedLogin | { foreign: true }> {
  // Decided first: whether saved accounts name this launch's login at all.
  if (await agyLaunchIsForeign({ ...process.env, ...env })) {
    return { foreign: true }
  }
  const selected = await AGY_HOST_SELECTION.atLaunch()
  let login: AgyPreparedLogin | { foreign: true }
  try {
    if (process.platform === 'win32') {
      login = await windowsLaunchLogin(selected)
    } else {
      const found = await prepareAntigravityAccountForLaunch({
        launchAgent: 'antigravity',
        env: { ...env },
        mayPrompt: false
      })
      login = { key: found ?? selected, target: found ?? selected }
    }
  } catch (error) {
    console.warn("[antigravity] chat starts on agy's current login:", error)
    login = agyLoginAfterFailure(selected, error)
  }
  if (!('foreign' in login)) {
    AGY_HOST_SELECTION.prepared(login)
  }
  return login
}

// The last agy Orca started on a previous account may have written its login back as it ran.
AGY_HOST_SELECTION.onOldLoginsGone(() => {
  void prepareAntigravityAccountForLaunch({
    launchAgent: 'antigravity',
    mayPrompt: false,
    quiet: true
  }).then(
    (found) => {
      if (typeof found === 'string') {
        AGY_HOST_SELECTION.prepared({ key: found, target: found })
      }
    },
    (error: unknown) => console.warn("[antigravity] the selected account wasn't put back:", error)
  )
})
