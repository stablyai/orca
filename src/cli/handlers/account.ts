import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
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
}

/** Renders a provider's managed-account list as a human-readable block, marking the active account. */
function formatAccountsBlock(label: string, block: AccountsBlock): string {
  if (block.accounts.length === 0) {
    return `No managed ${label} accounts.`
  }
  const lines = block.accounts.map(
    (account) => `  ${account.email}${account.id === block.activeAccountId ? ' (active)' : ''}`
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
  extraEnv: Record<string, string>
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
      // Why: on Windows the agent CLIs are `.cmd` shims that Node's spawn cannot
      // execute without a shell; args here are fixed literals, so there is no
      // interpolation/injection risk from enabling the shell.
      shell: process.platform === 'win32'
    })
    child.on('error', (error) =>
      rejectPromise(
        new RuntimeClientError(
          'internal',
          `Could not launch \`${command}\`. Is it installed and on PATH? (${
            error instanceof Error ? error.message : String(error)
          })`
        )
      )
    )
    child.on('exit', (code) =>
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

/** Logs into a Claude account in a temp config dir, then registers it with the local runtime. */
async function addClaudeAccount({ client, json }: HandlerContext): Promise<void> {
  const configDir = mkdtempSync(join(tmpdir(), 'orca-account-add-claude-'))
  try {
    await runAgentLoginInTerminal('claude', ['auth', 'login', '--claudeai'], {
      CLAUDE_CONFIG_DIR: configDir
    })
    const result = await client.call<ClaudeRateLimitAccountsState>(
      'accounts.addClaudeFromConfigDir',
      { configDir }
    )
    printResult(result, json, (state) => formatAccountsBlock('Claude', state))
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}

/** Logs into a Codex account in a temp CODEX_HOME, then registers it with the local runtime. */
async function addCodexAccount({ client, json }: HandlerContext): Promise<void> {
  const codexHome = mkdtempSync(join(tmpdir(), 'orca-account-add-codex-'))
  try {
    await runAgentLoginInTerminal('codex', ['login'], { CODEX_HOME: codexHome })
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
