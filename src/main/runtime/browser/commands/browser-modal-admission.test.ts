import { afterEach, expect, it, vi } from 'vitest'
import { createModalAdmissionFixture } from './browser-modal-admission-fixture'
import { BrowserCertificateTrustController } from '../../../browser/certificate-trust/browser-certificate-trust-controller'
import {
  reserveBrowserPageDiscard,
  closeBrowserMemoryPage
} from '../../../browser/guest-lifecycle/browser-page-memory'

import { AgentBrowserBridge } from '../../../browser/agent-browser/agent-browser-bridge'
import { overrideBridgeWebContentsLookup } from '../../../browser/agent-browser/testing/agent-browser-bridge-test-harness'
const { native, caller, leases, waitRegistration } = vi.hoisted(() => {
  const native: {
    guests: Map<number, Electron.WebContents>
    certificate?: BrowserCertificateTrustController
  } = { guests: new Map() }
  return {
    native,
    caller: { agent: true },
    leases: new Set<number>(),
    waitRegistration: vi.fn(async () => {})
  }
})
vi.mock('electron', () => ({
  app: { getPath: () => '/modal-test', getAppPath: () => '/modal-test', isPackaged: false },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: (id: number) => native.guests.get(id) }
}))
vi.mock('../../../browser/agent-browser/helper-process/agent-browser-process-environment', () => ({
  createAgentBrowserProcessEnvironment: () => ({ env: {}, ownsSocketDirectory: false })
}))
vi.mock('../../../runtime/rpc/rpc-active-caller', () => ({
  getActiveRpcCaller: () => ({ kind: caller.agent ? 'local-cli' : 'desktop' })
}))
vi.mock('../../../window/renderer-publication-throttle', () => ({
  rendererPublicationThrottle: {
    acquire: (guest: Electron.WebContents) => {
      leases.add(guest.id)
      return () => leases.delete(guest.id)
    }
  }
}))
vi.mock(
  '../../../browser/guest-lifecycle/manager/registration/browser-guest-discard-protection',
  () => ({
    markInitialBrowserGuest: vi.fn(),
    readBrowserGuestDiscardProtection: () => ({ protection: 'discardable' })
  })
)
vi.mock('../../../ipc/browser/browser-tab-registration-wait', () => ({
  waitForTabRegistration: waitRegistration,
  waitForTabFirstLoad: async () => {},
  waitForWorktreeTabRegistration: async () => {}
}))
vi.mock('../../../browser/guest-lifecycle/browser-main-window-readiness', () => ({
  whenBrowserMainWindowReady: async () => null
}))
vi.mock('../../../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserManager: {},
  browserCertificateTrustController: {
    proceed: (page: string, challenge: string) => native.certificate?.proceed(page, challenge)
  }
}))
overrideBridgeWebContentsLookup(
  AgentBrowserBridge.prototype,
  vi.fn((id: number) => native.guests.get(id))
)

const ownedPages = new Set<string>()
const fixture = () => createModalAdmissionFixture(native, ownedPages)
afterEach(() => {
  for (const page of ownedPages) {
    closeBrowserMemoryPage(page)
  }
  for (const guest of native.guests.values()) {
    native.certificate?.onGuestRetired(guest.id)
    guest.close()
  }
  ownedPages.clear()
  native.guests.clear()
  delete native.certificate
  leases.clear()
  caller.agent = true
  waitRegistration.mockClear()
})

const pageId = 'modal-page'

it.each([true, false])(
  'answers a pending native dialog during unresolved restore with agent=%s ownership already applied',
  async (agent) => {
    const f = fixture()
    await f.cold()
    caller.agent = agent
    let restored: ReturnType<typeof f.attach> | undefined
    const answered = vi.fn((_accepted: boolean, _text: string) => {
      expect(leases.has(restored!.guest.id)).toBe(agent)
    })
    f.onActivate(() => {
      restored = f.attach()
      restored.guest.emit(
        '-run-dialog',
        { dialogType: 'confirm', messageText: 'Continue?', defaultPromptText: '' },
        answered
      )
    })
    await expect(f.commands.browserDialogAccept({ page: pageId })).resolves.toMatchObject({
      accepted: true
    })
    expect(answered).toHaveBeenCalledWith(true, '')
    await restored!.finish()
    expect(reserveBrowserPageDiscard(pageId, restored!.guest)).toBe(!agent)
  }
)

it.each(['browserDialogAccept', 'browserDialogDismiss'] as const)(
  'keeps a valid cold page held after the normal no-dialog error from %s',
  async (command) => {
    const f = fixture()
    await f.cold()
    let restored: ReturnType<typeof f.attach> | undefined
    f.onActivate(() => {
      restored = f.attach()
    })
    await expect(f.commands[command]({ page: pageId })).rejects.toThrow('No JavaScript dialog')
    await restored!.finish()
    expect(reserveBrowserPageDiscard(pageId, restored!.guest)).toBe(false)
  }
)

it.each(['reject', 'wrong'])(
  'does not durably claim an existing page outside a %s workspace selector',
  async (worktree) => {
    const f = fixture()
    const page = f.attach()
    await page.finish()
    await expect(f.commands.browserDialogAccept({ page: pageId, worktree })).rejects.toThrow()
    expect(leases.has(page.guest.id)).toBe(false)
    expect(reserveBrowserPageDiscard(pageId, page.guest)).toBe(true)
  }
)

it('preserves missing certificate targets and holds before an actual accepted native reload', async () => {
  const f = fixture()
  const page = f.attach()
  await page.finish()
  native.certificate = new BrowserCertificateTrustController({
    resolveManagedGuestContext: (id) =>
      id === page.guest.id
        ? {
            browserPageId: pageId,
            worktreeId: 'workspace',
            sessionProfileId: 'modal',
            owner: 'desktop-webview'
          }
        : null,
    resolveWebContentsIdForPage: (id) => f.tabs.get(id) ?? null,
    resolveWebContents: (id) => native.guests.get(id) ?? null,
    onFailureChanged: () => {},
    createChallengeId: () => 'challenge'
  })
  native.certificate.installSessionRequestGuard(page.guest.session)
  native.certificate.handleCertificateError({
    event: { preventDefault: () => {} },
    webContents: page.guest,
    url: 'https://localhost/app',
    error: 'net::ERR_CERT_AUTHORITY_INVALID',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller hashes this PEM data and reads no other native certificate metadata.
    certificate: Object.assign({} as Electron.Certificate, {
      data: '-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----'
    }),
    callback: () => {},
    isMainFrame: true
  })
  await expect(f.commands.browserProceedCertificate({ challengeId: 'challenge' })).resolves.toEqual(
    { ok: false, reason: 'missing' }
  )
  expect(leases.has(page.guest.id)).toBe(false)
  page.load.mockClear()
  page.load.mockImplementation(async () => {
    expect(leases.has(page.guest.id)).toBe(true)
  })
  await expect(
    f.commands.browserProceedCertificate({ page: pageId, challengeId: 'challenge' })
  ).resolves.toEqual({ ok: true })
  expect(page.load).toHaveBeenCalledWith('https://localhost/app')
  await expect(
    f.commands.browserProceedCertificate({ page: pageId, challengeId: 'challenge' })
  ).resolves.toEqual({ ok: false, reason: 'missing' })
})

it('answers implicit wake-selected X without claiming the first saved Y', async () => {
  const f = fixture()
  await f.cold('saved-y')
  await f.cold('actual-x')
  f.catalog.push({
    browserPageId: 'saved-y',
    worktreeId: 'workspace',
    title: 'Y',
    url: 'https://localhost/y',
    loadError: null,
    certificateFailure: null
  })
  let actual: ReturnType<typeof f.attach> | undefined
  f.onActivate(() => {
    actual = f.attach('actual-x')
  })
  await expect(f.commands.browserDialogDismiss({})).rejects.toThrow('No JavaScript dialog')
  await actual!.finish()
  expect(reserveBrowserPageDiscard('actual-x', actual!.guest)).toBe(false)
  caller.agent = false
  const untouched = f.attach('saved-y')
  await untouched.finish()
  expect(reserveBrowserPageDiscard('saved-y', untouched.guest)).toBe(true)
})

it('does not activate a closed popup while returning its native target error', async () => {
  const f = fixture()
  await expect(f.commands.browserDialogAccept({ page: 'popup-999' })).rejects.toThrow(
    'was not found'
  )
  expect(f.send).not.toHaveBeenCalled()
  expect(waitRegistration).not.toHaveBeenCalled()
})

it('answers a live popup without creating a durable renderer-page claim', async () => {
  const f = fixture()
  const popup = f.attach('popup-900')
  await popup.finish()
  closeBrowserMemoryPage('popup-900')
  const answered = vi.fn()
  popup.guest.emit(
    '-run-dialog',
    { dialogType: 'confirm', messageText: 'Popup?', defaultPromptText: '' },
    answered
  )
  await expect(f.commands.browserDialogDismiss({ page: 'popup-900' })).resolves.toMatchObject({
    accepted: false
  })
  expect(answered).toHaveBeenCalledWith(false, '')
  expect(f.send).not.toHaveBeenCalled()
  caller.agent = false
  const reused = f.attach('popup-900')
  await reused.finish()
  expect(reserveBrowserPageDiscard('popup-900', reused.guest)).toBe(true)
})

it.each(['browserDialogAccept', 'browserDialogDismiss', 'browserProceedCertificate'] as const)(
  'ignores caller admission callbacks on managed %s answers',
  async (command) => {
    const f = fixture()
    const page = f.attach()
    await page.finish()
    f.managedPages.add(pageId)
    const callerAdmission = vi.fn(() => {
      throw new Error('Caller must not control admission')
    })
    const answered = vi.fn()
    if (command === 'browserProceedCertificate') {
      native.certificate = new BrowserCertificateTrustController({
        resolveManagedGuestContext: () => null,
        resolveWebContentsIdForPage: (id) => f.tabs.get(id) ?? null,
        resolveWebContents: (id) => native.guests.get(id) ?? null,
        onFailureChanged: () => {}
      })
      await expect(
        f.commands.browserProceedCertificate(
          { page: pageId, challengeId: 'missing' },
          callerAdmission
        )
      ).resolves.toEqual({ ok: false, reason: 'missing' })
    } else {
      page.guest.emit(
        '-run-dialog',
        { dialogType: 'confirm', messageText: 'Managed?', defaultPromptText: '' },
        answered
      )
      await expect(f.commands[command]({ page: pageId }, callerAdmission)).resolves.toMatchObject({
        accepted: command === 'browserDialogAccept'
      })
      expect(answered).toHaveBeenCalledWith(command === 'browserDialogAccept', '')
    }
    expect(callerAdmission).not.toHaveBeenCalled()
    expect(leases.has(page.guest.id)).toBe(false)
    expect(reserveBrowserPageDiscard(pageId, page.guest)).toBe(true)
  }
)
