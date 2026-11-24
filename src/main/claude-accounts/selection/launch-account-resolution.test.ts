import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import type { PluginHookChainOutcome } from '../../../shared/plugins/workers/plugin-hook-chain'
import {
  PluginHookDeniedError,
  setPluginHookRunner
} from '../../plugins/hooks/plugin-hook-dispatch'
import { resolveLaunchAccount } from './launch-account-resolution'

function account(id: string, email: string): ClaudeManagedAccount {
  return {
    id,
    email,
    managedAuthPath: `/tmp/${id}`,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

const settings = {
  claudeManagedAccounts: [account('a1', 'work@example.com'), account('a2', 'home@example.com')]
}
const base = { agent: 'claude', workspaceId: 'ws-1' }

function installHook(run: (payload: Record<string, unknown>) => PluginHookChainOutcome): void {
  setPluginHookRunner({
    wants: (event) => event === 'agent.account.resolve',
    run: async (_event, payload) =>
      run(
        typeof payload === 'object' && payload !== null
          ? Object.fromEntries(Object.entries(payload))
          : {}
      )
  })
}

describe('resolveLaunchAccount', () => {
  afterEach(() => setPluginHookRunner(null))

  it('prefers the launch, then the automation, then the bot, and null with none', async () => {
    expect(await resolveLaunchAccount({ ...base, bot: 'a1', automation: 'a2' }, settings)).toEqual({
      kind: 'managed',
      accountId: 'a2'
    })
    expect(
      await resolveLaunchAccount(
        { ...base, bot: 'a1', automation: 'a2', explicit: 'system' },
        settings
      )
    ).toEqual({ kind: 'system' })
    expect(await resolveLaunchAccount({ ...base, bot: 'a1' }, settings)).toEqual({
      kind: 'managed',
      accountId: 'a1'
    })
    expect(await resolveLaunchAccount(base, settings)).toBeNull()
  })

  it('lets a plugin pick the account, handing it the bot and its own account', async () => {
    const seen: Record<string, unknown>[] = []
    installHook((payload) => {
      seen.push(payload)
      return { kind: 'continue', payload: { ...payload, account: 'home@example.com' } }
    })
    const resolved = await resolveLaunchAccount({ ...base, botId: 'bot-1', bot: 'a1' }, settings)
    expect(resolved).toEqual({ kind: 'managed', accountId: 'a2' })
    expect(seen).toEqual([{ ...base, botId: 'bot-1', account: 'a1' }])
  })

  it('does not hook a launch that names its own account', async () => {
    const run = vi.fn()
    setPluginHookRunner({ wants: () => true, run })
    expect(await resolveLaunchAccount({ ...base, explicit: 'a1' }, settings)).toEqual({
      kind: 'managed',
      accountId: 'a1'
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('falls back to the saved account when the plugin names none that exists', async () => {
    installHook((payload) => ({ kind: 'continue', payload: { ...payload, account: 'ghost' } }))
    expect(await resolveLaunchAccount({ ...base, bot: 'a1' }, settings)).toBeNull()
  })

  it('falls back to the saved account when the hook breaks, and refuses when it denies', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setPluginHookRunner({
      wants: () => true,
      run: async () => {
        throw new Error('worker crashed')
      }
    })
    expect(await resolveLaunchAccount({ ...base, bot: 'a1' }, settings)).toEqual({
      kind: 'managed',
      accountId: 'a1'
    })
    installHook(() => ({ kind: 'deny', pluginKey: 'gate', reason: 'no data-class account' }))
    await expect(resolveLaunchAccount({ ...base, bot: 'a1' }, settings)).rejects.toBeInstanceOf(
      PluginHookDeniedError
    )
    warn.mockRestore()
  })
})
