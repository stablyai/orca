import { describe, expect, it } from 'vitest'
import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostedPageInventory
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type {
  BrowserClientPageLifecycleRegistry,
  BrowserClientRetainedPage
} from '../lifecycle/browser-client-page-retained-state'
import { BrowserClientPageInitializations } from './browser-client-page-initializations'

const KILLED_SERVER = {
  authorityRuntimeId: 'killed-server',
  authorityEpoch: 'epoch-1',
  browserHostClientId: 'desktop',
  browserHostGeneration: 1,
  pageHostGeneration: 7
}

function commandEvent(
  authority: typeof KILLED_SERVER,
  command: BrowserClientHostCommandEvent['command']
): BrowserClientHostCommandEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: initializations read only authority, page id and command.
  return {
    ...authority,
    browserPageId: 'page-1',
    type: 'command',
    command
  } as unknown as BrowserClientHostCommandEvent
}

describe('BrowserClientPageInitializations', () => {
  // A server killed mid-restore leaves this page outcome-unknown; its successor must be able to close it, or every later page in the profile waits on it.
  it('keeps a failed creation cleanup closable after its host lease releases it', async () => {
    const failedPages = new Map<string, BrowserClientHostedPageInventory>()
    const initializations = new BrowserClientPageInitializations(
      new Map<string, BrowserClientRetainedPage>(),
      failedPages,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: close never touches the route registry.
      {} as BrowserClientPageLifecycleRegistry,
      async () => {}
    )
    const create = commandEvent(KILLED_SERVER, {
      type: 'createPage',
      browserProfileId: 'default',
      executionHostKey: 'route',
      initialUrl: 'https://example.com/'
    })
    const owner = initializations.acquire(create)!
    let retried = false
    // What a creation whose guest cleanup failed leaves behind.
    initializations.begin(create)!.failedCleanup = async () => {
      retried = true
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cleanup matches only the authority fields.
    failedPages.set('page-1', {
      ...KILLED_SERVER,
      browserPageId: 'page-1',
      state: 'outcomeUnknown'
    } as BrowserClientHostedPageInventory)

    owner.release()

    const close = commandEvent(
      { ...KILLED_SERVER, authorityRuntimeId: 'restarted-server' },
      { type: 'closePage', targetAuthority: KILLED_SERVER }
    )
    expect(initializations.ownsClose(close)).toBe(true)
    await initializations.close(close, new AbortController().signal)
    expect(retried).toBe(true)
    expect(failedPages.has('page-1')).toBe(false)
  })
})
