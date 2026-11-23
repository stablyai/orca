import {
  setBrowserGuestSemanticVisibility,
  readBrowserGuestDiscardAdmission
} from '../../browser/guest-lifecycle/manager/registration/browser-guest-discard-protection'
import { getBrowserPageIdleDiscard } from '../../browser/guest-lifecycle/browser-page-idle-discard'
import type {
  BrowserGuestIdleDiscardToken,
  BrowserGuestVisibilityReport,
  BrowserGuestIdleDiscardRequest
} from '../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'
import { ipcMain, webContents } from 'electron'
import { normalizeBrowserGuestSrc } from '../../../shared/browser/extensions/browser-extension-url'
import {
  prepareBrowserPageAttach,
  reserveBrowserPageDiscard,
  acknowledgeBrowserPageRemoval
} from '../../browser/guest-lifecycle/browser-page-memory'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import { isWorkspaceDocPageId } from '../../browser/document-preview/doc-preview-guest-policy'
import { whenBrowserPartitionReadyForPage } from '../../browser/extensions/profile-sessions/browser-extension-page-readiness'
import {
  freeBrowserClientPageGuest,
  wakeBrowserClientPage
} from '../../browser/client-pages/lifecycle/browser-client-page-memory-registry'

export function registerBrowserGuestDiscardHandlers(): void {
  const scheduler = getBrowserPageIdleDiscard()
  ipcMain.removeAllListeners('browser:reportGuestVisibility')
  ipcMain.on('browser:reportGuestVisibility', (event, report: BrowserGuestVisibilityReport) => {
    if (
      !isTrustedBrowserRenderer(event.sender) ||
      typeof report?.browserPageId !== 'string' ||
      isWorkspaceDocPageId(report.browserPageId) ||
      typeof report.webContentsId !== 'number' ||
      !Number.isSafeInteger(report.generation) ||
      (report.visible !== null && typeof report.visible !== 'boolean')
    ) {
      return
    }
    const guest = browserManager.getAuthorizedGuest(report.browserPageId, event.sender.id)
    if (guest?.id === report.webContentsId) {
      if (
        scheduler.report(report, event.sender.id, (request) =>
          event.sender.send('browser:guest-idle-discard-due', request)
        )
      ) {
        setBrowserGuestSemanticVisibility(guest, report.visible)
      }
    }
  })
  ipcMain.removeAllListeners('browser:refuseGuestIdleDiscard')
  ipcMain.on('browser:refuseGuestIdleDiscard', (event, request: BrowserGuestIdleDiscardRequest) => {
    if (
      isTrustedBrowserRenderer(event.sender) &&
      typeof request?.browserPageId === 'string' &&
      request.policyToken?.rendererId === event.sender.id
    ) {
      scheduler.refuse(request.browserPageId, request.webContentsId, request.policyToken)
    }
  })
  ipcMain.removeHandler('browser:preparePageAttach')
  ipcMain.handle(
    'browser:preparePageAttach',
    async (
      event,
      args: {
        browserPageId?: unknown
        partition?: unknown
        url?: unknown
        restored?: unknown
        waited?: unknown
      }
    ) => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        typeof args?.browserPageId !== 'string' ||
        typeof args.partition !== 'string' ||
        typeof args.url !== 'string'
      ) {
        throw new Error('Invalid browser page attach')
      }
      const url = normalizeBrowserGuestSrc(args.url)
      if (!url) {
        throw new Error('Invalid browser page URL')
      }
      const marker = prepareBrowserPageAttach(
        args.browserPageId,
        event.sender.id,
        args.partition,
        url,
        args.restored === true
      )
      // The guest is created only once the profile's extensions have started (see the readiness).
      if (args.waited !== true) {
        await whenBrowserPartitionReadyForPage(args.partition)
      }
      return marker
    }
  )
  ipcMain.removeAllListeners('browser:reserveGuestDiscard')
  ipcMain.on(
    'browser:reserveGuestDiscard',
    (
      event,
      args: {
        browserPageId?: unknown
        webContentsId?: unknown
        policyToken?: BrowserGuestIdleDiscardToken
      }
    ) => {
      let committed = false
      try {
        if (
          !isTrustedBrowserRenderer(event.sender) ||
          typeof args?.browserPageId !== 'string' ||
          typeof args.webContentsId !== 'number'
        ) {
          return
        }
        const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
        if (!guest || guest.id !== args.webContentsId) {
          return
        }
        if (
          args.policyToken &&
          (args.policyToken.rendererId !== event.sender.id ||
            !scheduler.admit(args.browserPageId, guest.id, args.policyToken))
        ) {
          return
        }
        if (
          (!args.policyToken ||
            readBrowserGuestDiscardAdmission(guest, true).protection === 'discardable') &&
          !browserManager.isGuestMemoryProtected(args.browserPageId) &&
          (reserveBrowserPageDiscard(args.browserPageId, guest) ||
            freeBrowserClientPageGuest(args.browserPageId, guest))
        ) {
          committed = true
          browserManager.unregisterGuest(args.browserPageId, 'guest-destroyed')
        } else if (
          browserManager.readGuestDiscardProtection(args.browserPageId, guest).protection !==
          'discardable'
        ) {
          browserManager.invalidateGuestMemoryProtection(guest)
        }
      } catch {
        console.warn('[BrowserManager] Guest discard admission failed')
      } finally {
        if (
          !committed &&
          typeof args?.browserPageId === 'string' &&
          typeof args.webContentsId === 'number' &&
          args.policyToken?.rendererId === event.sender.id
        ) {
          scheduler.refuse(args.browserPageId, args.webContentsId, args.policyToken)
        }
        event.returnValue = committed
      }
    }
  )
  ipcMain.removeAllListeners('browser:acknowledgeGuestRemoval')
  ipcMain.removeHandler('browser:acknowledgeGuestRemoval')
  ipcMain.handle(
    'browser:acknowledgeGuestRemoval',
    (event, args: { browserPageId?: unknown; webContentsId?: unknown }) => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        typeof args?.browserPageId !== 'string' ||
        typeof args.webContentsId !== 'number'
      ) {
        return
      }
      const guest = webContents.fromId(args.webContentsId)
      return guest
        ? acknowledgeBrowserPageRemoval(args.browserPageId, guest, event.sender.id)
        : true
    }
  )
  ipcMain.removeHandler('browser:wakeClientPage')
  ipcMain.handle('browser:wakeClientPage', (event, args: { browserPageId?: unknown }) =>
    isTrustedBrowserRenderer(event.sender) && typeof args?.browserPageId === 'string'
      ? wakeBrowserClientPage(args.browserPageId)
      : false
  )
  ipcMain.removeHandler('browser:getGuestDiscardProtection')
  ipcMain.handle(
    'browser:getGuestDiscardProtection',
    (event, args: { browserPageId: string; webContentsId: number }) => {
      if (!isTrustedBrowserRenderer(event.sender) || typeof args?.browserPageId !== 'string') {
        return null
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      return guest && guest.id === args.webContentsId
        ? browserManager.readGuestDiscardProtection(args.browserPageId, guest)
        : null
    }
  )
}
