import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  resolveBrowserPageReference,
  resolveTerminalReference,
  type SessionTabsInventory
} from './copied-tab-reference'

const BROWSER_TAB = 'c6def874-6e3b-4f21-91da-9acf6759f976'
const BROWSER_PAGE = 'd29722cd-5834-4dd1-9027-2b449a216260'
const TERMINAL_TAB = '0a7cc9d3-af43-4b69-bc20-c11d3f4c9d99'
const SPLIT_TAB = '5b1d2c3e-1111-4222-8333-944455556666'

const inventory: SessionTabsInventory = {
  snapshots: [
    {
      worktree: 'repo::/w',
      tabs: [
        { type: 'browser', id: BROWSER_TAB, browserPageId: BROWSER_PAGE },
        {
          type: 'terminal',
          id: `${TERMINAL_TAB}::leaf-1`,
          parentTabId: TERMINAL_TAB,
          leafId: 'leaf-1',
          terminal: 'term_one'
        },
        {
          type: 'terminal',
          id: `${SPLIT_TAB}::a`,
          parentTabId: SPLIT_TAB,
          leafId: 'a',
          terminal: 'term_a'
        },
        {
          type: 'terminal',
          id: `${SPLIT_TAB}::b`,
          parentTabId: SPLIT_TAB,
          leafId: 'b',
          terminal: 'term_b'
        }
      ]
    }
  ]
}

function clientReturning(result: unknown): {
  client: RuntimeClient
  call: ReturnType<typeof vi.fn>
} {
  const call = vi.fn(async () => ({ id: 'req', ok: true, result }))
  return { client: { call } as unknown as RuntimeClient, call }
}

describe('resolveBrowserPageReference', () => {
  it('maps a copied browser tab id to the page the tab shows', async () => {
    const { client } = clientReturning(inventory)
    await expect(resolveBrowserPageReference(client, BROWSER_TAB)).resolves.toBe(BROWSER_PAGE)
  })

  it('keeps a page id that is not a tab id', async () => {
    const { client } = clientReturning(inventory)
    await expect(resolveBrowserPageReference(client, BROWSER_PAGE)).resolves.toBe(BROWSER_PAGE)
  })

  it('skips the lookup for values that are not tab ids', async () => {
    const { client, call } = clientReturning(inventory)
    await expect(resolveBrowserPageReference(client, 'popup:12')).resolves.toBe('popup:12')
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps the value when an older host has no tab inventory', async () => {
    const call = vi.fn(async () => {
      throw new RuntimeClientError('method_not_found', 'Unknown method')
    })
    const client = { call } as unknown as RuntimeClient
    await expect(resolveBrowserPageReference(client, BROWSER_TAB)).resolves.toBe(BROWSER_TAB)
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
          tabs: [
            { type: 'terminal', id: 'x', parentTabId: TERMINAL_TAB, leafId: 'l', terminal: null }
          ]
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
