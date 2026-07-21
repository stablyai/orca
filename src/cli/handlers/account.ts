import { spawn } from 'node:child_process'
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

/**
 * Runs the real agent login attached to the user's terminal so the OAuth
 * URL/device-code prompt is visible and the code can be pasted back — the desktop
 * GUI flow drives this via a browser Orca can't reach on a headless host.
 */
async function runAgentLoginInTerminal(
  command: string,
  args: string[],
  extraEnv: Record<string, string>,
  json: boolean
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
    child.once('exit', (code) =>
      code === 0
        ? resolvePromise()
        : rejectPromise(
            new RuntimeClientError(
              'internal',
              `\`${command} ${args.join(' ')}\` exited with code ${code ?? 'null'}.`
            )
          )
    )
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
  let legacyCredentials: string | null = null
  let restoreLegacyCredentials = false
  try {
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
      json
    )
    const result = await client.call<ClaudeRateLimitAccountsState>(
      'accounts.addClaudeFromConfigDir',
      { configDir }
    )
    printResult(result, json, (state) => formatAccountsBlock('Claude', state))
  } finally {
    await cleanupClaudeLoginKeychain(configDir, legacyCredentials, restoreLegacyCredentials)
    rmSync(configDir, { recursive: true, force: true })
  }
}

/** Logs into a Codex account in a temp CODEX_HOME, then registers it with the local runtime. */
async function addCodexAccount({ client, json }: HandlerContext): Promise<void> {
  const codexHome = mkdtempSync(join(tmpdir(), 'orca-account-add-codex-'))
  try {
    // Why: plain OAuth binds a loopback callback the user's browser cannot reach
    // on a headless/SSH host; device auth is explicitly designed for this flow.
    await runAgentLoginInTerminal(
      'codex',
      ['login', '--device-auth'],
      { CODEX_HOME: codexHome },
      json
    )
    const result = await client.call<CodexRateLimitAccountsState>('accounts.addCodexFromHome', {
      sourceHome: codexHome
    })
    printResult(result, json, (state) => formatAccountsBlock('Codex', state))
  } finally {
    rmSync(codexHome, { recursive: true, force: true })
  }
}

/** CLI handlers for `orca account add [--agent claude|codex]` and `orca account list`. */
export const ACCOUNT_HANDLERS: Record<string, CommandHandler> = {
  'account add': async (ctx) => {
    const agentFlag = ctx.flags.get('agent')
    const agent = typeof agentFlag === 'string' && agentFlag.length > 0 ? agentFlag : 'claude'
    if (agent === 'claude') {
      await addClaudeAccount(ctx)
    } else if (agent === 'codex') {
      await addCodexAccount(ctx)
    } else {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unsupported --agent "${agent}". Use "claude" or "codex".`
      )
    }
  },
  'account list': async ({ client, json }) => {
    const result = await client.call<AccountsListSnapshot>('accounts.list')
    printResult(
      result,
      json,
      (snapshot) =>
        `${formatAccountsBlock('Claude', snapshot.claude)}\n\n${formatAccountsBlock('Codex', snapshot.codex)}`
    )
  }
}
