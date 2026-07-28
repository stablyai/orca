import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { stripElectronRunAsNode } from '../runtime/launch'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentialsStrict,
  writeActiveClaudeKeychainCredentials
} from '../../main/claude-accounts/keychain'
import { resolveCliCommand } from '../../main/codex-cli/command'
import { getSpawnArgsForWindows } from '../../main/win32-utils'
import type { ClaudeRateLimitAccountsState, CodexRateLimitAccountsState } from '../../shared/types'

// Why: add returns just that provider's state; list returns the full snapshot.
type AccountsListSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
}

// Why: Claude and Codex managed-account summaries both carry id+email+active id,
// so one formatter renders either provider's block.
type AccountsBlock = {
  accounts: readonly { id: string; email: string }[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: {
    host: string | null
    wsl: Record<string, string | null>
  }
}

/** Renders a provider's managed-account list as a human-readable block, marking the active account. */
function formatAccountsBlock(label: string, block: AccountsBlock): string {
  if (block.accounts.length === 0) {
    return `No managed ${label} accounts.`
  }
  const activeAccountIds = new Set([
    block.activeAccountId,
    block.activeAccountIdsByRuntime?.host,
    ...Object.values(block.activeAccountIdsByRuntime?.wsl ?? {})
  ])
  const lines = block.accounts.map(
    (account) => `  ${account.email}${activeAccountIds.has(account.id) ? ' (active)' : ''}`
  )
  return `Managed ${label} accounts (${block.accounts.length}):\n${lines.join('\n')}`
}

// Why: `child` lets an interrupt stop the login; `registering` marks the window
// where the runtime already owns the captured credentials.
type LoginSession = { child: ChildProcess | null; registering: boolean }

// Why: SIGHUP is the interrupt that matters most here — this flow exists for
// headless/SSH hosts, where a dropped connection hangs up the login's terminal.
const INTERRUPT_EXIT_CODES: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }
const INTERRUPT_SIGNALS = Object.keys(INTERRUPT_EXIT_CODES) as NodeJS.Signals[]

/**
 * Runs `add` with `cleanup` guaranteed to run exactly once, including on Ctrl-C.
 * Node's default signal handling terminates without unwinding `finally`, which
 * would strand the temp dir's OAuth credentials on disk and, on macOS, leave the
 * swapped Keychain item in place — an interactive login is interrupted often.
 */
async function withInterruptCleanup(
  session: LoginSession,
  cleanup: () => Promise<void>,
  add: () => Promise<void>
): Promise<void> {
  // Why: memoize rather than latch a boolean — a second signal must await the
  // in-flight cleanup, not skip it and `process.exit` out of a pending Keychain
  // call (each up to 3s) that has not restored the user's credentials yet.
  let cleanupPromise: Promise<void> | null = null
  const cleanupOnce = (): Promise<void> => (cleanupPromise ??= cleanup())
  const onSignal = (signal: NodeJS.Signals): void => {
    session.child?.kill(signal)
    if (session.registering) {
      // Why: sign-in already succeeded and the runtime registers independently of
      // this process, so an interrupt here cannot be reported as "not added".
      console.warn(
        '[account] Interrupted after sign-in completed; the account may still have been registered. Run `orca account list` to check.'
      )
    }
    void cleanupOnce().finally(() => process.exit(INTERRUPT_EXIT_CODES[signal] ?? 1))
  }
  // Why: `on`, not `once` — with `once` a second Ctrl-C reverts to Node's
  // terminate-immediately default and kills the process mid-cleanup.
  for (const signal of INTERRUPT_SIGNALS) {
    process.on(signal, onSignal)
  }
  try {
    await add()
  } finally {
    try {
      await cleanupOnce()
    } catch (error) {
      // Why: a cleanup failure (Windows EBUSY on the temp dir) must not replace the
      // error that actually explains why the add failed.
      console.warn('[account] Failed to clean up the temporary login directory:', error)
    } finally {
      // Why: stay armed until cleanup settles — detaching first leaves the
      // multi-second Keychain calls below covered only by Node's default handling,
      // which kills the process mid-cleanup.
      for (const signal of INTERRUPT_SIGNALS) {
        process.off(signal, onSignal)
      }
    }
  }
}

/**
 * Runs the real agent login attached to the user's terminal so the OAuth
 * URL/device-code prompt is visible and the code can be pasted back — the desktop
 * GUI flow drives this via a browser Orca can't reach on a headless host.
 */
async function runAgentLoginInTerminal(
  command: string,
  args: string[],
  extraEnv: Record<string, string>,
  json: boolean,
  session: LoginSession
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const resolvedCommand = resolveCliCommand(command)
    const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolvedCommand, args)
    const env = { ...stripElectronRunAsNode(process.env), ...extraEnv }
    const child = spawn(spawnCmd, spawnArgs, {
      // Why: JSON mode reserves stdout for the response envelope while keeping
      // the interactive login attached to the user's terminal via stderr.
      stdio: ['inherit', json ? process.stderr : 'inherit', 'inherit'],
      env
    })
    session.child = child
    child.once('error', (error) =>
      rejectPromise(
        new RuntimeClientError(
          'internal',
          `Could not launch \`${command}\`. Is it installed and on PATH? (${
            error instanceof Error ? error.message : String(error)
          })`
        )
      )
    )
    child.once('exit', (code) => {
      session.child = null
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(
        new RuntimeClientError(
          'internal',
          `\`${command} ${args.join(' ')}\` exited with code ${code ?? 'null'}.`
        )
      )
    })
  })
}

async function cleanupClaudeLoginKeychain(
  configDir: string,
  legacyCredentials: string | null,
  restoreLegacyCredentials: boolean
): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }
  try {
    await deleteActiveClaudeKeychainCredentialsStrict(configDir)
  } catch (error) {
    console.warn('[account] Failed to remove temporary Claude Keychain credentials:', error)
  }
  if (!restoreLegacyCredentials) {
    return
  }
  try {
    await (legacyCredentials
      ? writeActiveClaudeKeychainCredentials(legacyCredentials)
      : deleteActiveClaudeKeychainCredentialsStrict())
  } catch (error) {
    console.warn('[account] Failed to restore Claude Keychain credentials:', error)
  }
}

/** Logs into a Claude account in a temp config dir, then registers it with the local runtime. */
async function addClaudeAccount({ client, json }: HandlerContext): Promise<void> {
  const configDir = mkdtempSync(join(tmpdir(), 'orca-account-add-claude-'))
  const session: LoginSession = { child: null, registering: false }
  let legacyCredentials: string | null = null
  let restoreLegacyCredentials = false
  await withInterruptCleanup(
    session,
    async () => {
      await cleanupClaudeLoginKeychain(configDir, legacyCredentials, restoreLegacyCredentials)
      rmSync(configDir, { recursive: true, force: true })
    },
    async () => {
      if (process.platform === 'darwin') {
        legacyCredentials = await readActiveClaudeKeychainCredentialsStrict()
        restoreLegacyCredentials = true
      }
      await runAgentLoginInTerminal(
        'claude',
        ['auth', 'login', '--claudeai'],
        {
          CLAUDE_CONFIG_DIR: configDir
        },
        json,
        session
      )
      session.registering = true
      const result = await client.call<ClaudeRateLimitAccountsState>(
        'accounts.addClaudeFromConfigDir',
        { configDir }
      )
      printResult(result, json, (state) => formatAccountsBlock('Claude', state))
    }
  )
}

/** Logs into a Codex account in a temp CODEX_HOME, then registers it with the local runtime. */
async function addCodexAccount({ client, json }: HandlerContext): Promise<void> {
  const codexHome = mkdtempSync(join(tmpdir(), 'orca-account-add-codex-'))
  const session: LoginSession = { child: null, registering: false }
  await withInterruptCleanup(
    session,
    async () => {
      rmSync(codexHome, { recursive: true, force: true })
    },
    async () => {
      // Why: plain OAuth binds a loopback callback the user's browser cannot reach
      // on a headless/SSH host; device auth is explicitly designed for this flow.
      await runAgentLoginInTerminal(
        'codex',
        ['login', '--device-auth'],
        { CODEX_HOME: codexHome },
        json,
        session
      )
      session.registering = true
      const result = await client.call<CodexRateLimitAccountsState>('accounts.addCodexFromHome', {
        sourceHome: codexHome
      })
      printResult(result, json, (state) => formatAccountsBlock('Codex', state))
    }
  )
}

/**
 * Rejects the runtime-selector flags instead of ignoring them. shouldIgnoreRemoteSelection
 * pins account commands to the local runtime, so honoring `--environment homelab`
 * silently would target the laptop rather than the host the user named — the exact
 * mistake this feature exists to avoid. A `--help` note does not reach someone who
 * already typed the flag.
 */
function rejectRemoteSelectionFlags(ctx: HandlerContext, command: string): void {
  for (const flag of ['environment', 'pairing-code']) {
    if (ctx.flags.has(flag)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `\`--${flag}\` does not retarget \`${command}\`. Run it on the host whose accounts you want to manage.`
      )
    }
  }
}

/** CLI handlers for `orca account add [--agent claude|codex]` and `orca account list`. */
export const ACCOUNT_HANDLERS: Record<string, CommandHandler> = {
  'account add': async (ctx) => {
    const agentFlag = ctx.flags.get('agent')
    // Why: a valueless `--agent` parses as boolean true; defaulting it to claude
    // would silently run a full OAuth login for the provider the user did not ask for.
    if (agentFlag !== undefined && typeof agentFlag !== 'string') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Missing a value for --agent. Use `--agent claude` or `--agent codex`.'
      )
    }
    const agent = agentFlag ?? 'claude'
    if (agent !== 'claude' && agent !== 'codex') {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unsupported --agent "${agent}". Use "claude" or "codex".`
      )
    }
    rejectRemoteSelectionFlags(ctx, 'orca account add')
    // Why: the login is a full interactive OAuth round trip. Fail before burning it
    // if the runtime that has to register the account is not reachable.
    await ctx.client.call('accounts.list', { refreshUsage: false })
    await (agent === 'claude' ? addClaudeAccount(ctx) : addCodexAccount(ctx))
  },
  'account list': async (ctx) => {
    rejectRemoteSelectionFlags(ctx, 'orca account list')
    const { client, json } = ctx
    // Why: this command renders no usage numbers, so skip the forced provider
    // refresh — it is one serial network round-trip per managed account.
    const result = await client.call<AccountsListSnapshot>('accounts.list', {
      refreshUsage: false
    })
    printResult(
      result,
      json,
      (snapshot) =>
        `${formatAccountsBlock('Claude', snapshot.claude)}\n\n${formatAccountsBlock('Codex', snapshot.codex)}`
    )
  }
}
