import { app, BaseWindow, protocol, session } from 'electron'
import { renameSync, writeFileSync } from 'node:fs'
import { ORCA_BROWSER_PARTITION } from '../../../shared/constants'
import { applyBackgroundActivationPolicy } from '../../window/foreground-activation-policy'
import { browserSessionRegistry } from '../browser-session-registry'
import { initializeBrowserExtensionSupport } from './browser-extension-startup'
import { BROWSER_EXTENSION_API_CUSTOM_SCHEME } from './browser-extension-api-scheme'
import { attachBrowserExtensionsToProfileSession } from './browser-extension-session-loader'
import {
  addUnpackedBrowserExtension,
  reloadUnpackedBrowserExtension
} from './browser-extension-management'

const statusPath = process.env.ORCA_EXTENSION_FIXTURE_STATUS
const extensionDirectory = process.env.ORCA_EXTENSION_FIXTURE_DIR
const phase = process.env.ORCA_EXTENSION_FIXTURE_PHASE
if (
  !statusPath ||
  !extensionDirectory ||
  (phase !== 'install' && phase !== 'restart' && phase !== 'update') ||
  process.env.ORCA_BACKGROUND_LAUNCH !== '1'
) {
  throw new Error(
    'Lifecycle fixture requires a status path, an extension, a phase and background launch'
  )
}
const fixtureStatusPath = statusPath
const fixtureExtensionDirectory = extensionDirectory
// Events the worker has stored by the end of each phase; the update phase reloads at 4.
const EXPECTED_EVENTS = { install: 1, restart: 2, update: 5 }[phase]
// Long enough for a duplicate delivery to show up before the phase ends.
const SETTLE_MS = 2_000

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
let extensionId = ''
let reloading = false
let settleTimer: NodeJS.Timeout | undefined

function writeStatus(): void {
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

function capture(message: string): void {
  const prefix = 'ORCA_EXT_LIFECYCLE '
  if (!message.startsWith(prefix)) {
    return
  }
  const events: unknown = JSON.parse(message.slice(prefix.length))
  const count = Array.isArray(events) ? events.length : 0
  status.events = events
  writeStatus()
  if (phase === 'update' && count === 4 && !reloading) {
    reloading = true
    void reloadUnpackedBrowserExtension(extensionId).then((result) => {
      status.reloaded = result
      writeStatus()
    })
  }
  if (count >= EXPECTED_EVENTS) {
    clearTimeout(settleTimer)
    // Why quit, not exit: will-quit flushes the versions the next launch compares against.
    settleTimer = setTimeout(() => {
      status.done = true
      writeStatus()
      app.quit()
    }, SETTLE_MS)
  }
}

async function run(): Promise<void> {
  await app.whenReady()
  initializeBrowserExtensionSupport({ enabled: true })
  const profile = browserSessionRegistry.getDefaultProfile()
  session
    .fromPartition(ORCA_BROWSER_PARTITION)
    .serviceWorkers.on('console-message', (_event, details) => capture(details.message))
  if (phase === 'install') {
    attachBrowserExtensionsToProfileSession(profile, [])
    status.added = await addUnpackedBrowserExtension(profile.id, fixtureExtensionDirectory)
    writeStatus()
    return
  }
  const enabled = browserSessionRegistry.getEnabledExtensionIds(profile.id)
  extensionId = enabled[0] ?? ''
  attachBrowserExtensionsToProfileSession(profile, enabled)
}

void run().catch(fail)
