import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import type { ClaudeManagedAccountSummary, ClaudeRateLimitAccountsState } from '../../shared/types'

// Why: the runtime returns just the Claude state from add; list returns the full
// accounts snapshot. Type only the Claude slice we render either way.
type ClaudeAccountsSnapshot = { claude: ClaudeRateLimitAccountsState }

function formatAccountLine(
  account: ClaudeManagedAccountSummary,
  activeAccountId: string | null
): string {
  const active = account.id === activeAccountId ? ' (active)' : ''
  const org = account.organizationName ? ` — ${account.organizationName}` : ''
  return `  ${account.email}${org}${active}`
}

function formatClaudeAccounts(state: ClaudeRateLimitAccountsState): string {
  if (state.accounts.length === 0) {
    return 'No managed Claude accounts.'
  }
  const lines = state.accounts.map((account) => formatAccountLine(account, state.activeAccountId))
  return `Managed Claude accounts (${state.accounts.length}):\n${lines.join('\n')}`
}

// Why: run the real `claude login` attached to the user's terminal so the OAuth
// URL/device-code prompt is visible and the code can be pasted back — the desktop
// GUI flow drives this via a browser Orca can't reach on a headless host.
async function runClaudeLoginInTerminal(configDir: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('claude', ['auth', 'login', '--claudeai'], {
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }
    })
    child.on('error', (error) =>
      rejectPromise(
        new RuntimeClientError(
          'internal',
          `Could not launch \`claude\`. Is Claude Code installed and on PATH? (${
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
              `\`claude login\` exited with code ${code ?? 'null'}.`
            )
          )
    )
  })
}

export const ACCOUNT_HANDLERS: Record<string, CommandHandler> = {
  'account add': async ({ client, json }) => {
    const configDir = mkdtempSync(join(tmpdir(), 'orca-account-add-'))
    try {
      await runClaudeLoginInTerminal(configDir)
      const result = await client.call<ClaudeRateLimitAccountsState>(
        'accounts.addClaudeFromConfigDir',
        { configDir }
      )
      printResult(result, json, formatClaudeAccounts)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  },
  'account list': async ({ client, json }) => {
    const result = await client.call<ClaudeAccountsSnapshot>('accounts.list')
    printResult(result, json, (snapshot) => formatClaudeAccounts(snapshot.claude))
  }
}
