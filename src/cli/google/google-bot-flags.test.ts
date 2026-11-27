import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { GOOGLE_BOT_ACCOUNTS_RUNTIME_CAPABILITY } from '../../shared/google/google-connect-types'
import type { HandlerContext } from '../dispatch/dispatch'
import { GOOGLE_HANDLERS } from './google'
import { formatGoogleStatus } from './google-status-format'

// google.bot.set's params on a host from before account choice (v1.4.273): a list is dropped.
const OlderHostParams = z.object({ botId: z.string(), on: z.boolean() })

function run(
  flags: Record<string, string | boolean>,
  host: { capabilities: string[]; older?: boolean } = {
    capabilities: [GOOGLE_BOT_ACCOUNTS_RUNTIME_CAPABILITY]
  }
) {
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'bots.list') {
      return { result: { bots: [{ id: 'scout', name: 'Scout' }] } }
    }
    if (method === 'status.get') {
      return { result: { machineName: 'old-mac', capabilities: host.capabilities } }
    }
    const saved: Record<string, unknown> = host.older
      ? OlderHostParams.parse(params)
      : (params ?? {})
    return {
      result: {
        bot: {
          name: 'Scout',
          google: params?.on === true,
          ...(saved.accounts ? { accounts: saved.accounts } : {})
        }
      }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these fields.
  const ctx = {
    flags: new Map(Object.entries({ bot: 'Scout', ...flags })),
    client: { call },
    json: true
  } as unknown as HandlerContext
  return { done: GOOGLE_HANDLERS['google bot']!(ctx), call }
}

describe('orca google bot', () => {
  it('sends --accounts as a list with Google on, and --on/--off without one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const accounts = run({ accounts: ' Me@Work.com,me@gmail.com,me@work.com ' })
    await accounts.done
    expect(accounts.call).toHaveBeenLastCalledWith('google.bot.set', {
      botId: 'scout',
      on: true,
      accounts: ['me@work.com', 'me@gmail.com']
    })
    const on = run({ on: true })
    await on.done
    expect(on.call).toHaveBeenLastCalledWith('google.bot.set', {
      botId: 'scout',
      on: true,
      allAccounts: true
    })
    const off = run({ off: true })
    await off.done
    expect(off.call).toHaveBeenLastCalledWith('google.bot.set', { botId: 'scout', on: false })
  })

  it('never sends --accounts to a host that would drop the list', async () => {
    const older = run({ accounts: 'me@work.com' }, { capabilities: [], older: true })
    await expect(older.done).rejects.toThrow('Update Orca on old-mac to choose accounts.')
    expect(older.call).not.toHaveBeenCalledWith('google.bot.set', expect.anything())
    // On/off still works there.
    await run({ on: true }, { capabilities: [], older: true }).done
    // A host that claims account choice but drops the list fails loudly.
    const dropped = run(
      { accounts: 'me@work.com' },
      { capabilities: [GOOGLE_BOT_ACCOUNTS_RUNTIME_CAPABILITY], older: true }
    )
    await expect(dropped.done).rejects.toThrow("didn't keep the account list")
  })

  it('takes exactly one of --on, --off and --accounts, and only emails', async () => {
    await expect(run({ on: true, accounts: 'me@work.com' }).done).rejects.toThrow(
      'Pass one of --on, --off or --accounts.'
    )
    await expect(run({}).done).rejects.toThrow('Pass one of --on, --off or --accounts.')
    await expect(run({ accounts: 'me@work.com,scout' }).done).rejects.toThrow('not scout')
    // An empty list is refused, never read as absent: --on would then mean every account.
    await expect(run({ accounts: '' }).done).rejects.toThrow('not an empty one')
    const widened = run({ on: true, accounts: '' })
    await expect(widened.done).rejects.toThrow('not an empty one')
    expect(widened.call).not.toHaveBeenCalled()
  })

  it('names an agent with no chosen accounts plainly in orca google status', () => {
    const status = formatGoogleStatus({
      client: null,
      accounts: [],
      bots: [
        { id: 'scout', name: 'Scout', accounts: [] },
        { id: 'cos', name: 'CoS' }
      ]
    })
    expect(status).toContain('Scout (no Google accounts chosen), CoS (every account)')
  })

  it('marks the default in orca google status whatever the email case', () => {
    const status = formatGoogleStatus({
      client: null,
      accounts: [{ email: 'Me@Gmail.com', status: 'connected', services: [], connectedAt: 0 }],
      defaultAccount: 'me@gmail.com',
      bots: []
    })
    expect(status).toContain('Me@Gmail.com (default): connected')
  })
  it('says Reconnect once for an ended account in orca google status', () => {
    const status = formatGoogleStatus({
      client: null,
      accounts: [
        {
          email: 'me@work.com',
          status: 'reconnect',
          reason: 'Google access ended (revoked, expired, or the password changed).',
          googleError: 'Token has been expired or revoked. (invalid_grant)',
          services: [],
          connectedAt: 0
        }
      ],
      bots: []
    })
    expect(status).toContain(
      'me@work.com: Reconnect. Google access ended (revoked, expired, or the password changed). Google said: Token has been expired or revoked. (invalid_grant). Run `orca google connect --account me@work.com`.'
    )
  })
})
