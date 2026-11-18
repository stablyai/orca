import { expect, it } from 'vitest'
import { routeRuntimeBrowserClientAutomation } from './runtime-browser-client-automation'
import type { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'
import type { BrowserClientAutomationResult } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import {
  BrowserClientPageCommandError,
  browserClientPageCommandFailure
} from '../../../browser/client-pages/execution/browser-client-page-command-failure'

async function legacyResponse(
  method: string,
  response: BrowserClientAutomationResult,
  params: Record<string, unknown> = {}
) {
  return routeRuntimeBrowserClientAutomation({
    method,
    params: { page: 'page', ...params },
    caller: undefined,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selected-page route reads only getPage.
    pages: {
      getPage: () => ({
        browserPageId: 'page',
        workspaceId: 'workspace',
        placement: {
          browserHostClientId: 'client',
          browserHostGeneration: 1,
          pageHostGeneration: 1
        }
      })
    } as unknown as RuntimeBrowserPageRegistry,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the completion route reads only authority identity and the issued promise.
    leases: {
      authorityRuntimeId: 'runtime',
      authorityEpoch: 1,
      clientPageInitializations: { lease: () => undefined },
      issueClientPageCommand: () => ({ result: Promise.resolve(response) })
    } as unknown as BrowserHostLeaseRegistry,
    resolveWorkspace: async () => ({ id: 'workspace' }),
    resolveWorkspacePath: async () => '/unused'
  })
}

function legacyReply(method: string, value: unknown) {
  return legacyResponse(method, { status: 'completed', value })
}

function failed(detail: string) {
  return browserClientPageCommandFailure(
    new BrowserClientPageCommandError('browser_error', { detail }),
    new AbortController().signal
  )
}

it('redacts typed legacy navigation and action receipts at the host boundary', async () => {
  const raw = 'https://kagi.com/search?q=one&token=legacy-secret'
  expect(await legacyReply('browser.reload', { url: raw, title: raw, checkedUrl: raw })).toEqual({
    handled: true,
    result: {
      url: 'https://kagi.com/search?q=one',
      title: 'https://kagi.com/search?q=one',
      checkedUrl: 'https://kagi.com/search?q=one'
    }
  })
  expect(
    await legacyReply('browser.click', {
      clicked: '#go',
      effects: {
        url: raw,
        title: raw,
        newTabs: [{ url: raw }],
        popups: [{ action: 'blocked', origin: raw }],
        downloads: [{ filename: 'report', origin: raw }],
        blockedPrint: { origin: raw },
        body: raw
      }
    })
  ).toEqual({
    handled: true,
    result: {
      clicked: '#go',
      effects: {
        url: 'https://kagi.com/search?q=one',
        title: 'https://kagi.com/search?q=one',
        newTabs: [{ url: 'https://kagi.com/search?q=one' }],
        popups: [{ action: 'blocked', origin: 'https://kagi.com/search?q=one' }],
        downloads: [{ filename: 'report', origin: 'https://kagi.com/search?q=one' }],
        blockedPrint: { origin: 'https://kagi.com/search?q=one' },
        body: raw
      }
    }
  })
})

it('preserves arbitrary page output and ordinary URLs while cleaning eval metadata', async () => {
  expect(
    await legacyReply('browser.eval', {
      result: 'https://kagi.com/search?token=page-content',
      origin: 'https://kagi.com/search?token=legacy-secret&q=one'
    })
  ).toEqual({
    handled: true,
    result: {
      result: 'https://kagi.com/search?token=page-content',
      origin: 'https://kagi.com/search?q=one'
    }
  })
  expect(
    await legacyReply('browser.reload', {
      url: 'https://example.com/?token=ordinary',
      title: 'Example'
    })
  ).toEqual({
    handled: true,
    result: { url: 'https://example.com/?token=ordinary', title: 'Example' }
  })
})

it.each([
  ['https://kagi.com/search?q=one&token=legacy-secret', 'ERR_FAILED'],
  [
    'https://example.com/',
    "ERR_BLOCKED_BY_CLIENT (-20) loading 'https://kagi.com/search?q=one&token=legacy-secret'"
  ],
  [
    'https://example.com/',
    "ERR_FAILED loading 'HTTPS://www.KAGI.com/search?q=one&%74oken=legacy'quoted-secret'"
  ],
  ['kagi.com/search?token=legacy-secret&q=one', 'ERR_CONNECTION_CLOSED']
])('returns a safe legacy navigation failure for %s', async (url, detail) => {
  const response = failed(`Failed to navigate browser page page: ${detail}`)
  await expect(legacyResponse('browser.goto', response, { url })).rejects.toMatchObject({
    code: 'browser_error',
    message: 'Private navigation failed.'
  })
})

it.each([
  [
    'https://example.com/?token=ordinary',
    "ERR_NAME_NOT_RESOLVED loading 'https://example.com/?token=ordinary'"
  ],
  [
    'https://kagi.com/search?q=one',
    "ERR_CONNECTION_REFUSED loading 'https://kagi.com/search?q=one'"
  ]
])('keeps ordinary legacy navigation diagnostics for %s', async (url, detail) => {
  await expect(legacyResponse('browser.goto', failed(detail), { url })).rejects.toMatchObject({
    code: 'browser_error',
    message: detail
  })
})

it('cleans a legacy reload failure whose private destination exists only in the detail', async () => {
  await expect(
    legacyResponse(
      'browser.reload',
      failed("ERR_FAILED loading 'https://kagi.com/search?token=reload-secret&q=one'")
    )
  ).rejects.toMatchObject({ code: 'browser_error', message: 'Private navigation failed.' })
})

it('keeps legacy mismatch details safe through the production failure serializer', async () => {
  const response = browserClientPageCommandFailure(
    new BrowserClientPageCommandError('browser_error', {
      expectedUrlMismatch: {
        browserPageId: 'page',
        mayHaveStarted: false,
        expectedUrl: 'https://kagi.com/search?token=expected-secret&q=one',
        actualUrl: 'https://kagi.com/search?token=actual-secret&q=two'
      }
    }),
    new AbortController().signal
  )
  await expect(legacyResponse('browser.click', response)).rejects.toMatchObject({
    data: {
      browserPageId: 'page',
      mayHaveStarted: false,
      expectedUrl: 'https://kagi.com/search?q=one',
      actualUrl: 'https://kagi.com/search?q=two'
    }
  })
})
