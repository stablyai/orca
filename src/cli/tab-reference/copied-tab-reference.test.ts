import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  chatSessionForTabId,
  resolveBrowserPageReference,
  resolveRecipientReference,
  resolveTerminalReference,
  type SessionTabsInventory
} from './copied-tab-reference'

const BROWSER_TAB = 'c6def874-6e3b-4f21-91da-9acf6759f976'
const BROWSER_PAGE = 'd29722cd-5834-4dd1-9027-2b449a216260'
const TERMINAL_TAB = '0a7cc9d3-af43-4b69-bc20-c11d3f4c9d99'
const SPLIT_TAB = '5b1d2c3e-1111-4222-8333-944455556666'
const CHAT_SESSION = '0bf61e42-8693-47b2-aabd-40e22e81b930'

const pages = {
  tabs: [
    {
      browserPageId: BROWSER_PAGE,
      unifiedTabId: BROWSER_TAB,
      index: 0,
      url: 'https://example.com/',
      title: 'Example',
      active: true
    }
  ]
}

const inventory: SessionTabsInventory = {
  snapshots: [
    {
      worktree: 'repo::/w',
      tabs: [
        {
          type: 'terminal',
          id: `${TERMINAL_TAB}::l`,
          parentTabId: TERMINAL_TAB,
          terminal: 'term_one'
        },
        { type: 'terminal', id: `${SPLIT_TAB}::a`, parentTabId: SPLIT_TAB, terminal: 'term_a' },
        { type: 'terminal', id: `${SPLIT_TAB}::b`, parentTabId: SPLIT_TAB, terminal: 'term_b' }
      ]
    }
  ]
}

function clientReturning(result: unknown): {
  client: RuntimeClient
  call: ReturnType<typeof vi.fn>
} {
  const call = vi.fn(async () => ({ id: 'req', ok: true, result }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolvers only use `call`.
  return { client: { call } as unknown as RuntimeClient, call }
}

function clientFailing(code: string): RuntimeClient {
  const call = vi.fn(async () => {
    throw new RuntimeClientError(code, code)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolvers only use `call`.
  return { call } as unknown as RuntimeClient
}

describe('resolveBrowserPageReference', () => {
  it('maps a copied browser tab id to the page the tab shows', async () => {
    const { client, call } = clientReturning(pages)
    await expect(resolveBrowserPageReference(client, BROWSER_TAB)).resolves.toBe(BROWSER_PAGE)
    expect(call).toHaveBeenCalledWith('browser.tabList', {})
  })

  it('reads a pasted orcaTabId line with its own casing and spacing', async () => {
    const { client } = clientReturning(pages)
    await expect(
      resolveBrowserPageReference(client, ` orcaTabId: ${BROWSER_TAB.toUpperCase()} `)
    ).resolves.toBe(BROWSER_PAGE)
  })

  it('keeps a page id', async () => {
    const { client } = clientReturning(pages)
    await expect(resolveBrowserPageReference(client, BROWSER_PAGE)).resolves.toBe(BROWSER_PAGE)
  })

  it('skips the lookup for values that are not tab ids', async () => {
    const { client, call } = clientReturning(pages)
    await expect(resolveBrowserPageReference(client, 'popup:12')).resolves.toBe('popup:12')
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps the value when an older host lacks the listing', async () => {
    await expect(
      resolveBrowserPageReference(clientFailing('method_not_found'), BROWSER_TAB)
    ).resolves.toBe(BROWSER_TAB)
  })

  it('surfaces any other failure instead of reporting the page as missing later', async () => {
    await expect(
      resolveBrowserPageReference(clientFailing('runtime_unavailable'), BROWSER_TAB)
    ).rejects.toMatchObject({ code: 'runtime_unavailable' })
  })
})

describe('resolveTerminalReference', () => {
  it('maps a copied terminal tab id to the handle of its only terminal', async () => {
    const { client } = clientReturning(inventory)
    await expect(resolveTerminalReference(client, TERMINAL_TAB)).resolves.toBe('term_one')
  })

  it('passes a terminal handle through without a lookup', async () => {
    const { client, call } = clientReturning(inventory)
    await expect(resolveTerminalReference(client, 'term_one')).resolves.toBe('term_one')
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a split tab instead of picking one of its terminals', async () => {
    const { client } = clientReturning(inventory)
    await expect(resolveTerminalReference(client, SPLIT_TAB)).rejects.toMatchObject({
      code: 'invalid_argument',
      data: { nextSteps: ['--terminal term_a', '--terminal term_b'] }
    })
  })

  it('refuses a tab whose terminal has no handle yet', async () => {
    const { client } = clientReturning({
      snapshots: [
        {
          worktree: 'repo::/w',
          tabs: [{ type: 'terminal', id: 'x', parentTabId: TERMINAL_TAB, terminal: null }]
        }
      ]
    })
    await expect(resolveTerminalReference(client, TERMINAL_TAB)).rejects.toMatchObject({
      code: 'terminal_not_ready'
    })
  })

  it('keeps an id that names no terminal tab, so the runtime reports it', async () => {
    const { client } = clientReturning(inventory)
    await expect(resolveTerminalReference(client, BROWSER_TAB)).resolves.toBe(BROWSER_TAB)
  })
})

describe('copied chat tab ids', () => {
  it('name their chat session in both the copied and the inventory form', () => {
    expect(chatSessionForTabId(`structured-agent-session-${CHAT_SESSION}`)).toBe(CHAT_SESSION)
    expect(chatSessionForTabId(`agent-session:${CHAT_SESSION}`)).toBe(CHAT_SESSION)
    expect(chatSessionForTabId(TERMINAL_TAB)).toBeNull()
  })

  it('map to a session address as a recipient without a lookup, even for another server', async () => {
    const { client, call } = clientReturning(inventory)
    await expect(
      resolveRecipientReference(client, `structured-agent-session-${CHAT_SESSION}`, {
        remote: true
      })
    ).resolves.toBe(`orca_session_id:${CHAT_SESSION}`)
    expect(call).not.toHaveBeenCalled()
  })
})
