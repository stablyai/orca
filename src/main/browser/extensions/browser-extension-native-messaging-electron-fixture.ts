import { app, BaseWindow, BrowserWindow, protocol, session } from 'electron'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORCA_BROWSER_PARTITION } from '../../../shared/constants'
import { applyBackgroundActivationPolicy } from '../../window/foreground-activation-policy'
import { browserSessionRegistry } from '../browser-session-registry'
import { initializeBrowserExtensionSupport } from './browser-extension-startup'
import { BROWSER_EXTENSION_API_CUSTOM_SCHEME } from './browser-extension-api-scheme'
import { attachBrowserExtensionsToProfileSession } from './browser-extension-session-loader'
import { addUnpackedBrowserExtension } from './browser-extension-management'
import { trackBrowserExtensionMainWindow } from './browser-extension-window-model'
import { browserExtensionIdForUnpackedFolder } from './browser-extension-load-directory'
import { ORCA_NATIVE_MESSAGING_HOSTS_FOLDER } from './browser-extension-native-host-locations'

const statusPath = process.env.ORCA_EXTENSION_FIXTURE_STATUS
const extensionDirectory = process.env.ORCA_EXTENSION_FIXTURE_DIR
const userData = process.env.ORCA_NATIVE_FIXTURE_USER_DATA
const echoHost = process.env.ORCA_NATIVE_FIXTURE_ECHO_HOST
const exitHost = process.env.ORCA_NATIVE_FIXTURE_EXIT_HOST
if (
  !statusPath ||
  !extensionDirectory ||
  !userData ||
  !echoHost ||
  !exitHost ||
  process.env.ORCA_BACKGROUND_LAUNCH !== '1'
) {
  throw new Error('Native messaging fixture requires its paths and background launch')
}
const fixtureStatusPath = statusPath
const fixtureExtensionDirectory = extensionDirectory
const hosts = { echo: echoHost, exit: exitHost }

app.setPath('userData', userData)
protocol.registerSchemesAsPrivileged([BROWSER_EXTENSION_API_CUSTOM_SCHEME])

const presentationCalls: string[] = []
for (const method of ['show', 'showInactive', 'focus', 'moveTop'] as const) {
  BaseWindow.prototype[method] = () => {
    presentationCalls.push(method)
  }
}
app.focus = () => {
  presentationCalls.push('app.focus')
}
applyBackgroundActivationPolicy()

const status: Record<string, unknown> = { presentationCalls }

function writeStatus(): void {
  status.windowsHidden = BaseWindow.getAllWindows().every((window) => !window.isVisible())
  writeFileSync(`${fixtureStatusPath}.next`, JSON.stringify(status))
  renameSync(`${fixtureStatusPath}.next`, fixtureStatusPath)
}

function fail(error: unknown): void {
  status.error = String(error)
  writeStatus()
  app.exit(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

// Extension contexts report `ORCA_NM {"key":…,"value":…}` lines on the console.
function capture(message: string): void {
  if (!message.startsWith('ORCA_NM ')) {
    return
  }
  const { key, value }: { key: string; value: unknown } = JSON.parse(message.slice(8))
  status[key] = value
  writeStatus()
  // The test then checks the page's host is killed because its page went away.
  if (key === 'pageEcho' && typeof status.popout === 'number') {
    BrowserWindow.fromId(status.popout)?.destroy()
  }
}

function writeManifest(name: string, path: string, extensionId: string): void {
  const folder = join(app.getPath('userData'), ORCA_NATIVE_MESSAGING_HOSTS_FOLDER)
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, `${name}.json`),
    JSON.stringify({
      name,
      description: 'Orca test host',
      type: 'stdio',
      path,
      allowed_origins: [`chrome-extension://${extensionId}/`]
    })
  )
}

async function run(): Promise<void> {
  await app.whenReady()
  initializeBrowserExtensionSupport({ enabled: true })
  const profile = browserSessionRegistry.getDefaultProfile()
  attachBrowserExtensionsToProfileSession(profile, [])
  const extensionSession = session.fromPartition(ORCA_BROWSER_PARTITION)
  extensionSession.serviceWorkers.on('console-message', (_event, details) =>
    capture(details.message)
  )
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (details) => capture(details.message))
  })
  // Orca's main window, hidden; the worker opens the extension page as a popout of it.
  const host = new BrowserWindow({ show: false })
  trackBrowserExtensionMainWindow(host)
  await host.loadURL('data:text/html,<title>orca</title>')

  const extensionId = await browserExtensionIdForUnpackedFolder(fixtureExtensionDirectory)
  writeManifest('com.orca.echo', hosts.echo, extensionId)
  writeManifest('com.orca.exit', hosts.exit, extensionId)
  writeManifest('com.orca.forbidden', hosts.echo, 'a'.repeat(32))

  status.added = await addUnpackedBrowserExtension(profile.id, fixtureExtensionDirectory)
  writeStatus()

  // The test asks for a quit once it has checked everything else: quitting must kill open hosts.
  const quitSignal = `${fixtureStatusPath}.quit`
  const poll = setInterval(() => {
    if (existsSync(quitSignal)) {
      clearInterval(poll)
      app.quit()
    }
  }, 100)
}

void run().catch(fail)
