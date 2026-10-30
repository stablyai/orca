import { spawn } from 'node:child_process'
import { assertWslDistroAllowed } from '@orca/process-host/wsl-distro-allowlist'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { stripElectronRunAsNode } from '../runtime/orca-app-executable'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { buildWslExecArgs, buildWslLoginShellCommand } from '../../shared/wsl-login-shell-command'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { isWindowsFnmDefaultAliasDir } from '../../shared/fnm-default-alias-dirs'
import {
  getVersionManagerBinPaths,
  resolveCliCommand,
  withCliRuntimeOnPath
} from '../../shared/node-cli-command-resolution'
import {
  getSpawnArgsForWindows,
  UnsafeWindowsBatchArgumentsError,
  WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL
} from '../../shared/windows-batch-spawn'
import { stdioForWindowsInteractiveChild } from '../../shared/windows-console-input'
import {
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
  CLAUDE_SIGN_IN_RUNTIME_CAPABILITY
} from '../../shared/account-runtime-capabilities'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type {
  ClaudeAccountSignIn,
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  ManagedDataAccountsState
} from '../../shared/managed-account-types'
import {
  type InteractiveLoginSession,
  withInteractiveLoginCleanup
} from './interactive-login-interruption'
import { getWslAccountTarget } from './account-wsl-location'
import { addDataAccount, listDataAccounts, mutateDataAccount } from './data-account-commands'
import { formatAccountsBlock, formatDataAccounts } from './account-list-format'

type AccountsListSnapshot = {
  opencode?: ManagedDataAccountsState
  devin?: ManagedDataAccountsState
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
}

function addAgentNodePaths(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pathKey =
    process.platform === 'win32' && env.Path !== undefined && env.PATH === undefined
      ? 'Path'
      : 'PATH'
  const currentEntries = (env[pathKey] ?? '').split(delimiter).filter(Boolean)
  const existing = new Set(currentEntries)
  const missing = getVersionManagerBinPaths().filter((entry) => !existing.has(entry))
  if (missing.length > 0) {
    const append = missing.filter(isWindowsFnmDefaultAliasDir)
    const prepend = missing.filter((entry) => !append.includes(entry))
    env[pathKey] = [...prepend, ...currentEntries, ...append].join(delimiter)
  }
  return env
}

/** Attach login to the terminal so device-code authentication works on headless hosts. */
async function runAgentLoginInTerminal(
  command: string,
  args: string[],
  extraEnv: Record<string, string>,
  json: boolean,
  session: InteractiveLoginSession
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const resolvedCommand = resolveCliCommand(command)
    let spawnCmd: string
    let spawnArgs: string[]
    try {
      ;({ spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolvedCommand, args))
    } catch (error) {
      rejectPromise(
        error instanceof UnsafeWindowsBatchArgumentsError
          ? new RuntimeClientError(
              'invalid_environment',
              `Cannot run \`${command}\` from "${resolvedCommand}": the path contains characters ` +
                `cmd.exe would reinterpret. Install it somewhere without ` +
                `${WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL} in the path.`
            )
          : error
      )
      return
    }
    // Put the CLI's own Node ahead of newer version-manager bins to keep the command/runtime pair intact.
    const env = withCliRuntimeOnPath(
      resolvedCommand,
      addAgentNodePaths({ ...stripElectronRunAsNode(process.env), ...extraEnv })
    )
    try {
      assertWslDistroAllowed(spawnCmd, spawnArgs)
    } catch (error) {
      rejectPromise(error)
      return
    }
    const consoleStdio = stdioForWindowsInteractiveChild(json)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(spawnCmd, spawnArgs, {
        // Reserve stdout for JSON; keep interactive login on the terminal via stderr.
        stdio: consoleStdio.stdio,
        env
      })
    } finally {
      consoleStdio.dispose()
    }
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

async function addClaudeAccount({ client, cwd, json }: HandlerContext): Promise<void> {
  const { result: signIn } = await client.call<ClaudeAccountSignIn>(
    'accounts.beginClaudeSignIn',
    getWslAccountTarget(cwd) ?? {},
    { timeoutMs: 300_000 }
  )
  const session: InteractiveLoginSession = {
    child: null,
    registering: false,
    terminationPromise: null
  }
  const result = await withInteractiveLoginCleanup(
    session,
    // Cancel cleans abandoned folders and preserves registered accounts; older hosts may lack the method.
    async () => {
      const { accountId, runtime, wslDistro } = signIn
      await client
        .call('accounts.cancelClaudeSignIn', { accountId, runtime, wslDistro })
        .catch((error: unknown) => console.warn('[account] Could not clean up sign-in:', error))
    },
    async () => {
      if (signIn.runtime === 'wsl' && signIn.wslDistro) {
        const login = `exec env CLAUDE_CONFIG_DIR=${quotePosixShell(signIn.configDir)} claude auth login`
        await runAgentLoginInTerminal(
          'wsl.exe',
          buildWslExecArgs(signIn.wslDistro, ['/bin/sh', '-c', buildWslLoginShellCommand(login)]),
          {},
          json,
          session
        )
      } else {
        await runAgentLoginInTerminal(
          'claude',
          ['auth', 'login'],
          { CLAUDE_CONFIG_DIR: signIn.configDir },
          json,
          session
        )
      }
      session.registering = true
      return client.call<ClaudeRateLimitAccountsState>(
        'accounts.finishClaudeSignIn',
        { accountId: signIn.accountId, runtime: signIn.runtime, wslDistro: signIn.wslDistro },
        { timeoutMs: 300_000 }
      )
    }
  )
  printResult(result, json, (state) => formatAccountsBlock('Claude', state))
}

async function addCodexAccount({ client, cwd, json }: HandlerContext): Promise<void> {
  const codexHome = mkdtempSync(join(tmpdir(), 'orca-account-add-codex-'))
  const session: InteractiveLoginSession = {
    child: null,
    registering: false,
    terminationPromise: null
  }
  const result = await withInteractiveLoginCleanup(
    session,
    async () => {
      rmSync(codexHome, { recursive: true, force: true })
    },
    async () => {
      // Device auth works over SSH where the browser cannot reach the host's loopback OAuth callback.
      await runAgentLoginInTerminal(
        'codex',
        ['login', '--device-auth'],
        { CODEX_HOME: codexHome },
        json,
        session
      )
      session.registering = true
      return client.call<CodexRateLimitAccountsState>('accounts.addCodexFromHome', {
        sourceHome: codexHome,
        ...getWslAccountTarget(cwd)
      })
    }
  )
  printResult(result, json, (state) => formatAccountsBlock('Codex', state))
}

function rejectAccountRemoteSelectionFlags(ctx: HandlerContext, command: string): void {
  rejectRemoteSelectionFlags(
    ctx.flags,
    `\`${command}\`. Run it on the host whose accounts you want to manage.`
  )
}

async function assertAccountImportSupported(
  { client }: HandlerContext,
  agent: 'claude' | 'codex'
): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  const capability =
    agent === 'claude' ? CLAUDE_SIGN_IN_RUNTIME_CAPABILITY : ACCOUNT_IMPORT_RUNTIME_CAPABILITY
  if (!status.result.capabilities?.includes(capability)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The running Orca runtime is too old to add accounts from the CLI. Update or restart Orca and try again.'
    )
  }
}

export const ACCOUNT_HANDLERS: Record<string, CommandHandler> = {
  'account add': async (ctx) => {
    const agentFlag = ctx.flags.get('agent')
    // A valueless flag is true; never silently default it to a different provider's OAuth flow.
    if (agentFlag !== undefined && typeof agentFlag !== 'string') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Missing a value for --agent. Use `--agent claude`, `--agent codex`, `--agent opencode`, or `--agent devin`.'
      )
    }
    const agent = agentFlag ?? 'claude'
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'opencode' && agent !== 'devin') {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unsupported --agent "${agent}". Use "claude", "codex", "opencode", or "devin".`
      )
    }
    rejectAccountRemoteSelectionFlags(ctx, 'orca account add')
    if (agent === 'opencode' || agent === 'devin') {
      await addDataAccount(ctx, agent, runAgentLoginInTerminal)
      return
    }
    // Check runtime support before spending an OAuth round trip.
    await assertAccountImportSupported(ctx, agent)
    await ctx.client.call('accounts.list', { refreshUsage: false })
    await (agent === 'claude' ? addClaudeAccount(ctx) : addCodexAccount(ctx))
  },
  'account list': async (ctx) => {
    rejectAccountRemoteSelectionFlags(ctx, 'orca account list')
    const provider = ctx.flags.get('agent')
    if (provider !== undefined) {
      await listDataAccounts(ctx, provider)
      return
    }
    const { client, json } = ctx
    // Listing shows no usage, so avoid a serial provider refresh for every account.
    const result = await client.call<AccountsListSnapshot>('accounts.list', {
      refreshUsage: false
    })
    printResult(result, json, (snapshot) =>
      [
        formatAccountsBlock('Claude', snapshot.claude),
        formatAccountsBlock('Codex', snapshot.codex),
        ...(snapshot.opencode ? [formatDataAccounts('OpenCode', snapshot.opencode)] : []),
        ...(snapshot.devin ? [formatDataAccounts('Devin', snapshot.devin)] : [])
      ].join('\n\n')
    )
  },
  'account select': async (ctx) => {
    rejectAccountRemoteSelectionFlags(ctx, 'orca account select')
    await mutateDataAccount(ctx, 'select')
  },
  'account rm': async (ctx) => {
    rejectAccountRemoteSelectionFlags(ctx, 'orca account rm')
    await mutateDataAccount(ctx, 'remove')
  }
}
