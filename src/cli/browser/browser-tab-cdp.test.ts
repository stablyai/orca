import { expect, it, vi } from 'vitest'
import type { CommandHandler } from '../dispatch/dispatch'
import { BROWSER_TAB_HANDLERS } from './browser-tab'

type HandlerContext = Parameters<CommandHandler>[0]

it('refuses to fetch a tab CDP endpoint from a remote or paired Orca', async () => {
  const call = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these fields before refusing.
  const context = {
    flags: new Map([['page', 'page-1']]),
    client: { isRemote: true, call },
    cwd: '/tmp',
    json: false
  } as unknown as HandlerContext
  await expect(BROWSER_TAB_HANDLERS['tab cdp'](context)).rejects.toThrow(
    'only against the local Orca app'
  )
  expect(call).not.toHaveBeenCalled()
})
