import { describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch/dispatch'
import { GOOGLE_HANDLERS } from './google'

function run(flags: Record<string, string | boolean>) {
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) =>
    method === 'bots.list'
      ? { result: { bots: [{ id: 'scout', name: 'Scout' }] } }
      : { result: { bot: { name: 'Scout', google: params?.on === true } } }
  )
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
    expect(on.call).toHaveBeenLastCalledWith('google.bot.set', { botId: 'scout', on: true })
    const off = run({ off: true })
    await off.done
    expect(off.call).toHaveBeenLastCalledWith('google.bot.set', { botId: 'scout', on: false })
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
})
