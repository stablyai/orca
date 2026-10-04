import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { DATA_ACCOUNT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type {
  ManagedDataAccountProvider,
  ManagedDataAccountsState
} from '../../shared/managed-account-types'
import {
  withInteractiveLoginCleanup,
  type InteractiveLoginSession
} from './interactive-login-interruption'
import { getWslAccountTarget } from './account-wsl-location'
import { formatDataAccounts } from './account-list-format'

export async function assertDataAccountsSupported(ctx: HandlerContext): Promise<void> {
  const status = await ctx.client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(DATA_ACCOUNT_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Update or restart this Orca host to manage OpenCode and Devin accounts.'
    )
  }
}

export async function addDataAccount(
  ctx: HandlerContext,
  provider: ManagedDataAccountProvider,
  login: (
    command: string,
    args: string[],
    extraEnv: Record<string, string>,
    json: boolean,
    session: InteractiveLoginSession
  ) => Promise<void>
): Promise<void> {
  if (getWslAccountTarget(ctx.cwd)?.runtime === 'wsl') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Run this command inside the WSL host runtime; Windows-hosted WSL account import is not supported.'
    )
  }
  const label = ctx.flags.get('label') ?? provider
  if (typeof label !== 'string' || !label.trim() || label.trim().length > 120) {
    throw new RuntimeClientError('invalid_argument', '--label must contain 1–120 characters.')
  }
  await assertDataAccountsSupported(ctx)
  const integration = ctx.flags.get('integration')
  if (
    integration !== undefined &&
    (provider !== 'opencode' || typeof integration !== 'string' || !integration.trim())
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--integration requires an OpenCode integration ID or name.'
    )
  }
  const directory = mkdtempSync(join(tmpdir(), `orca-account-add-${provider}-`))
  const session: InteractiveLoginSession = {
    child: null,
    registering: false,
    terminationPromise: null
  }
  const result = await withInteractiveLoginCleanup(
    session,
    async () => {
      rmSync(directory, { recursive: true, force: true })
    },
    async () => {
      const dataHome = join(directory, 'data')
      await login(
        provider,
        provider === 'opencode'
          ? [
              'auth',
              'login',
              ...(typeof integration === 'string' ? [integration] : []),
              '--standalone'
            ]
          : ['auth', 'login', '--force-manual-token-flow'],
        {
          XDG_DATA_HOME: dataHome,
          XDG_CONFIG_HOME: join(directory, 'config'),
          XDG_CACHE_HOME: join(directory, 'cache'),
          XDG_STATE_HOME: join(directory, 'state'),
          ...(provider === 'opencode'
            ? {
                OPENCODE_CONFIG_DIR: join(directory, 'config', 'opencode'),
                OPENCODE_AUTH_CONTENT: '',
                OPENCODE_DB: 'opencode.db'
              }
            : {})
        },
        ctx.json,
        session
      )
      session.registering = true
      return ctx.client.call<ManagedDataAccountsState>('accounts.addDataFromHome', {
        provider,
        sourceDataHome: dataHome,
        label: label.trim()
      })
    }
  )
  printResult(result, ctx.json, (state) => formatDataAccounts(provider, state))
}

export async function listDataAccounts(ctx: HandlerContext, provider: unknown): Promise<void> {
  if (provider !== 'opencode' && provider !== 'devin') {
    throw new RuntimeClientError('invalid_argument', 'Use --agent opencode or --agent devin.')
  }
  await assertDataAccountsSupported(ctx)
  const result =
    await ctx.client.call<Partial<Record<ManagedDataAccountProvider, ManagedDataAccountsState>>>(
      'accounts.listData'
    )
  printResult(result, ctx.json, (snapshot) => {
    const state = snapshot[provider]
    if (!state) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Managed accounts are unavailable on this host.'
      )
    }
    return formatDataAccounts(provider, state)
  })
}

export async function mutateDataAccount(
  ctx: HandlerContext,
  action: 'select' | 'remove'
): Promise<void> {
  const provider = ctx.flags.get('agent')
  const id = ctx.flags.get('account')
  if ((provider !== 'opencode' && provider !== 'devin') || typeof id !== 'string' || !id) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use --agent opencode|devin and --account <id> (system for the default selection).'
    )
  }
  await assertDataAccountsSupported(ctx)
  const result = await ctx.client.call<ManagedDataAccountsState>(`accounts.${action}Data`, {
    provider,
    accountId: action === 'select' && id === 'system' ? null : id
  })
  printResult(result, ctx.json, (state) => formatDataAccounts(provider, state))
}
