import { describe, expect, it } from 'vitest'
import type { BrowserClientAutomationMethod } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientRetainedPage } from '../lifecycle/browser-client-page-retained-state'
import { executeBrowserClientPageAutomationCommand } from './browser-client-page-command-execution'

const AUTHORITY = {
  authorityRuntimeId: 'server-runtime',
  authorityEpoch: 1,
  browserHostClientId: 'desktop',
  browserHostGeneration: 1,
  pageHostGeneration: 1
}

function retainedPages(): Map<string, BrowserClientRetainedPage> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execution reads only these members.
  const page = {
    generation: 1,
    inventory: { ...AUTHORITY, browserProfileId: 'default' },
    registration: {},
    renderer: { rendererWebContentsId: 1, isCurrent: () => true },
    retiring: null,
    reconciling: false
  } as unknown as BrowserClientRetainedPage
  return new Map([['page-1', page]])
}

// An older server forwards these unchecked; the desktop must refuse them itself.
async function runFromServer(
  method: BrowserClientAutomationMethod,
  params: Record<string, unknown> = {}
): Promise<{ ran: string[]; outcome: unknown }> {
  const ran: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execution reads only these members.
  const event = {
    ...AUTHORITY,
    browserPageId: 'page-1',
    command: { type: 'automation', method, params }
  } as unknown as BrowserClientHostCommandEvent
  const outcome = await executeBrowserClientPageAutomationCommand(
    retainedPages(),
    async (input) => {
      ran.push(input.method)
      return { ok: true }
    },
    event,
    new AbortController().signal
  ).catch((error: unknown) => error)
  return { ran, outcome }
}

describe('client page commands from the page server', () => {
  it.each([
    ['browser.cookie.get', {}],
    ['browser.cookie.set', { name: 'session', value: 'x' }],
    ['browser.cookie.delete', { name: 'session' }],
    ['browser.clipboardRead', {}],
    ['browser.clipboardWrite', { text: 'x' }],
    ['browser.keypress', { key: 'Meta+V' }],
    ['browser.keypress', { key: 'Control+v' }],
    ['browser.keypress', { key: 'Shift+Insert' }],
    ['browser.keypress', { key: 'cmd+v' }]
  ] as const)('never reads the desktop cookies or clipboard: %s %j', async (method, params) => {
    const { ran, outcome } = await runFromServer(method, params)
    expect(ran).toEqual([])
    expect(outcome).toMatchObject({
      detail: expect.stringContaining('shown on the paired desktop')
    })
  })

  it('still runs page commands that use the sign-ins without reading them', async () => {
    for (const [method, params] of [
      ['browser.eval', { expression: 'document.title' }],
      ['browser.keypress', { key: 'Enter' }],
      ['browser.keypress', { key: 'Meta+c' }]
    ] as const) {
      expect(await runFromServer(method, params)).toEqual({ ran: [method], outcome: { ok: true } })
    }
  })
})
