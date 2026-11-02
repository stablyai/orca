import {
  app,
  BaseWindow,
  BrowserWindow,
  session,
  webContents,
  type Session,
  type WebContents
} from 'electron'
import { renameSync, writeFileSync } from 'node:fs'
import { applyBackgroundActivationPolicy } from '../window/foreground-activation-policy'
import { BrowserManager } from './browser-manager'
import { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'
import { initializeBrowserProcessUserAgent } from './browser-process-user-agent'
import type { PopupChildWindowOptions } from './popup-origin-bar-window'
import {
  BrowserPopupNativeFixture,
  popupFixtureContentSecurity as contentSecurity
} from './browser-popup-native-electron-fixture'
import type {
  BrowserRouteGuestLifecycleClaim,
  BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'

const origin = process.env.ORCA_POPUP_FIXTURE_ORIGIN
const statusPath = process.env.ORCA_POPUP_FIXTURE_STATUS
if (!origin || !statusPath || process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Popup fixture requires synthetic origin, status path and background launch')
}
const fixtureOrigin = origin
const fixtureStatusPath = statusPath
applyBackgroundActivationPolicy()
initializeBrowserProcessUserAgent('clean')

class FixtureBrowserManager extends BrowserManager {
  tabOpens: { url: string; activate: boolean | undefined }[] = []
  childRequests: {
    adopted: boolean
    native: boolean
    sessionMatches: boolean
    security: ReturnType<typeof contentSecurity>
    permission?: string
  }[] = []
  protected override openLinkInOrcaTab(pageId: string, url: string, activate?: boolean): boolean {
    this.tabOpens.push({ url, activate })
    writeStatus()
    return super.openLinkInOrcaTab(pageId, url, activate)
  }
  protected override createPopupChildWindowWithOriginBar(
    opener: WebContents,
    targetUrl: string,
    options: PopupChildWindowOptions
  ): WebContents {
    const contents = super.createPopupChildWindowWithOriginBar(opener, targetUrl, options)
    const record = {
      adopted: Boolean(options.webContents),
      native: Boolean(options.nativeWindow),
      sessionMatches: contents.session === opener.session,
      security: contentSecurity(contents),
      permission: 'pending'
    }
    this.childRequests.push(record)
    if (!options.webContents) {
      contents.once('did-finish-load', () => {
        void contents
          .executeJavaScript('Notification.requestPermission()')
          .then((permission: unknown) => {
            record.permission = typeof permission === 'string' ? permission : 'unknown'
            writeStatus()
          })
          .catch(() => {
            record.permission = 'unavailable'
            writeStatus()
          })
      })
    }
    writeStatus()
    return contents
  }
}

const manager = new FixtureBrowserManager()
const guests = new Map<string, WebContents>()
const hosts: BrowserWindow[] = []
const blocked: number[] = []
const inputs: string[] = []
let registry: BrowserRouteWebContentsRegistry | null = null
let ready = false
let phase = 'starting'
let routeIdentity: BrowserRoutePageGuestIdentity | null = null
let routeClaim: BrowserRouteGuestLifecycleClaim | null = null
let routeGranted = true
let fixtureRouteSession: Session | null = null
const authority = Symbol('fixture-route-authority')
let fixtureAuthority: symbol | null = authority
let fixtureAuthorityThrows = false
let revision = 0
const native = new BrowserPopupNativeFixture({
  routeSession: () => fixtureRouteSession,
  failAuthority: (throwOnRead) => {
    fixtureAuthority = null
    fixtureAuthorityThrows = throwOnRead
  },
  restoreAuthority: () => {
    fixtureAuthority = authority
    fixtureAuthorityThrows = false
  },
  writeStatus
})

function writeStatus(error?: string): void {
  writeFileSync(
    `${fixtureStatusPath}.next`,
    JSON.stringify({
      revision: ++revision,
      ready,
      phase,
      error,
      tabOpens: manager.tabOpens,
      childRequests: manager.childRequests,
      native: native.snapshot(),
      routeGranted,
      routeContents: webContents
        .getAllWebContents()
        .filter((contents) => fixtureRouteSession && contents.session === fixtureRouteSession)
        .map((contents) => ({
          security: contentSecurity(contents),
          webRtcPolicy: contents.getWebRTCIPHandlingPolicy()
        })),
      blocked,
      inputs,
      windowsHidden: BaseWindow.getAllWindows().every((window) => !window.isVisible()),
      guestIds: Object.fromEntries([...guests].map(([name, guest]) => [name, guest.id]))
    })
  )
  renameSync(`${fixtureStatusPath}.next`, fixtureStatusPath)
}

async function createHost(name: string, partition: string, nativeControl = false): Promise<void> {
  const host = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hidden popup probes still need compositor frames for real CDP input.
      backgroundThrottling: false,
      webviewTag: true
    }
  })
  hosts.push(host)
  phase = `${name}-host`
  writeStatus()
  const attached = new Promise<void>((resolve, reject) => {
    host.webContents.once('did-attach-webview', (_event, guest) => {
      phase = `${name}-attached`
      writeStatus()
      void (async () => {
        await new Promise<void>((resolve) => guest.once('did-finish-load', () => resolve()))
        guests.set(name, guest)
        native.trackRequests(guest)
        guest.on('input-event', (_event, input) => {
          inputs.push(input.type)
          writeStatus()
        })
        if (nativeControl) {
          native.installControlHandler(guest)
          await guest.loadURL(`${fixtureOrigin}/${name}`)
          resolve()
          return
        }
        manager.attachGuestPolicies(guest)
        if (
          !manager.registerGuest({
            browserPageId: name,
            webContentsId: guest.id,
            rendererWebContentsId: host.webContents.id
          })
        ) {
          throw new Error('Guest registration failed')
        }
        if (name === 'route') {
          const identity = {
            partition,
            browserPageId: name,
            webContentsId: guest.id,
            rendererWebContentsId: host.webContents.id,
            pageHostGeneration: 1
          }
          routeIdentity = identity
          if (
            !registry?.attachGuest(guest) ||
            !registry.registerGuest(identity) ||
            !registry.grantNavigation(identity)
          ) {
            throw new Error('Route guest registration failed')
          }
          guest.on('console-message', ({ message }) => {
            if (message === 'orca-popup-fixture:fence' && registry && routeIdentity) {
              routeClaim = registry.claimGuestLifecycle(routeIdentity)
              if (routeClaim) {
                routeGranted = !registry.revokeNavigation(routeClaim)
              }
              writeStatus()
            } else if (message === 'orca-popup-fixture:grant' && registry && routeClaim) {
              routeGranted = registry.grantReconciledNavigation(routeClaim)
              writeStatus()
            } else if (message === 'orca-popup-fixture:close') {
              guest.close()
            } else if (message === 'orca-popup-fixture:snapshot') {
              writeStatus()
            } else {
              native.handleMessage(message)
            }
          })
        }
        await guest.loadURL(`${fixtureOrigin}/${name}`)
        guest.once('destroyed', writeStatus)
        resolve()
      })().catch(reject)
    })
  })
  await Promise.all([
    host.loadURL(
      `data:text/html,${encodeURIComponent(
        `<webview allowpopups partition="${partition}" src="about:blank" style="width:800px;height:600px"></webview>`
      )}`
    ),
    attached
  ])
  phase = `${name}-host-loaded`
  writeStatus()
}

process.on('uncaughtException', (error) => {
  writeStatus(String(error))
  app.exit(1)
})
process.on('unhandledRejection', (error) => {
  writeStatus(String(error))
  app.exit(1)
})

async function run(): Promise<void> {
  writeStatus()
  await app.whenReady()
  phase = 'ready'
  writeStatus()
  const localPartition = 'popup-fixture-local'
  const routePartition = `persist:orca-browser-v1-${'a'.repeat(64)}`
  const localSession = session.fromPartition(localPartition)
  const routeSession = session.fromPartition(routePartition)
  fixtureRouteSession = routeSession
  await session.defaultSession.cookies.set({
    url: fixtureOrigin,
    name: 'synthetic_session',
    value: 'default'
  })
  for (const [targetSession, value] of [
    [localSession, 'local'],
    [routeSession, 'route']
  ] as const) {
    targetSession.setPermissionCheckHandler(() => false)
    targetSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    await targetSession.cookies.set({ url: fixtureOrigin, name: 'synthetic_session', value })
  }
  phase = 'sessions'
  writeStatus()
  // The synthetic HTTP proxy receipts prove descendants keep the opener's egress session.
  await routeSession.setProxy({
    proxyRules: `http=${fixtureOrigin}`,
    proxyBypassRules: '<-loopback>'
  })
  phase = 'proxy'
  writeStatus()
  registry = new BrowserRouteWebContentsRegistry({
    getPartitionForSession: (candidate) => (candidate === routeSession ? routePartition : null),
    getPreparedPageAuthority: () => {
      if (fixtureAuthorityThrows) {
        throw new Error('Synthetic authority lookup failure')
      }
      return fixtureAuthority
    },
    retirePreparedPage: () => true,
    retirePreparedPagesOwnedByRenderer: () => 0,
    reportBlockedPopup: (input) => {
      blocked.push(input.openerWebContentsId)
      writeStatus()
    }
  })
  // Playwright must attach before Electron changes guest targets from pages to webviews.
  await fetch(`${fixtureOrigin}/fixture-cdp-connected`)
  await createHost('local', localPartition)
  phase = 'local'
  writeStatus()
  await createHost('route', routePartition)
  if (process.env.ORCA_POPUP_FIXTURE_NATIVE_CONTROLS === '1') {
    await createHost('local-control', localPartition, true)
    await createHost('route-control', routePartition, true)
  }
  ready = true
  writeStatus()
}

void run().catch((error: unknown) => {
  writeStatus(String(error))
  app.exit(1)
})
