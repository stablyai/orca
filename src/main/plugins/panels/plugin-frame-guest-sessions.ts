import { app, session as electronSession, type Session, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import {
  PLUGIN_FRAME_SCHEME,
  pluginFrameKey,
  pluginFramePartition,
  pluginDeclarativeHostUrl,
  pluginFrameUrl,
  readPluginFramePartitionKey
} from '../../../shared/plugins/frames/plugin-frame-guest'
import type { PluginFrameGuest } from '../../../shared/plugins/frames/plugin-frame-bridge'
import type { PluginFrameSurface } from '../../../shared/plugins/frames/plugin-panel-shell'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import { pluginFrameContentRevision } from '../plugin-dev-revision'
import type { KeybindingOverrides } from '../../../shared/keybindings'
import { createPluginFrameRequestHandler } from './plugin-frame-protocol'
import { pluginFrameAttachKey } from './plugin-frame-request-policy'
import { applyPluginFrameSessionPolicies } from './plugin-frame-session-policies'
import {
  closePluginFrameGuests,
  installPluginFrameGuestPolicies
} from './plugin-frame-guest-policies'
import { setPluginFrameGuestHooks } from './plugin-frame-guest-registry'
import { installPluginFrameGuestDiagnostics } from './plugin-frame-guest-diagnostics'
import { currentPluginFrameThemeSnapshot } from './plugin-frame-theme-snapshot'

/**
 * One locked-down session per plugin for its `<webview>` frames (plugin-isolated-frames.md):
 * served only from the plugin root, network cancelled at the session, a refusing proxy for what
 * webRequest never sees, no permissions (copy works only on a gesture), no downloads.
 */

export type PluginFrameGuestSource = {
  /** Installed, enabled and consented; null otherwise. */
  findApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  listPluginKeys: () => readonly string[]
  /** Kill-listed plugins also lose their frame storage. */
  isKillListed?: (pluginKey: string) => boolean
  getKeybindings?: () => KeybindingOverrides | undefined
}

let source: PluginFrameGuestSource | null = null
const sessionsByKey = new Map<string, Promise<Session>>()
const readyKeys = new Set<string>()
const keyBySession = new WeakMap<Session, string>()
const pluginKeyByFrameKey = new Map<string, string>()
const killListCleared = new Set<string>()
let stopServiceBinding: (() => void) | null = null
let refusingProxyPort: Promise<number> | null = null

export function configurePluginFrameGuests(next: PluginFrameGuestSource | null): void {
  source = next
}

type PluginFrameGuestService = {
  findApprovedPlugin: (
    pluginKey: string,
    allowRefreshPause?: boolean
  ) => ValidDiscoveredPlugin | null
  getDiscovered: () => readonly { pluginKey?: string }[]
  onChanged: (listener: () => void) => () => void
  options: {
    getPluginKillListEntry?: (pluginKey: string) => unknown
    getKeybindings?: () => KeybindingOverrides | undefined
  }
}

/** Serves the plugin service's approved plugins, and revokes guests whenever approval changes. */
export function bindPluginFrameGuests(service: PluginFrameGuestService): void {
  configurePluginFrameGuests({
    // Why the refresh pause: a refresh (any worker start, crash or reap) briefly marks every plugin
    // unready; guests must not be closed, refused or 404d for that.
    findApprovedPlugin: (pluginKey) => service.findApprovedPlugin(pluginKey, true),
    listPluginKeys: () =>
      service.getDiscovered().flatMap((plugin) => (plugin.pluginKey ? [plugin.pluginKey] : [])),
    isKillListed: (pluginKey) => Boolean(service.options.getPluginKillListEntry?.(pluginKey)),
    getKeybindings: () => service.options.getKeybindings?.()
  })
  // Re-binding (window reload, tests) must not stack listeners on the old service.
  stopServiceBinding?.()
  stopServiceBinding = service.onChanged(() => void revokeUnapprovedPluginFrames())
}

export function findApprovedPluginByFrameKey(frameKey: string): ValidDiscoveredPlugin | null {
  if (!source) {
    return null
  }
  const pluginKey = source.listPluginKeys().find((key) => pluginFrameKey(key) === frameKey)
  return pluginKey ? source.findApprovedPlugin(pluginKey) : null
}

/** A loopback listener that drops every connection: the proxy for traffic webRequest cannot see. */
function startRefusingProxy(): Promise<number> {
  refusingProxyPort ??= new Promise<number>((resolve, reject) => {
    const server: Server = createServer((socket: Socket) => socket.destroy())
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('refusing proxy has no port'))
        return
      }
      // Never keep the app alive for a listener that only ever says no.
      server.unref()
      resolve(address.port)
    })
  }).catch((error: unknown) => {
    refusingProxyPort = null
    throw error
  })
  return refusingProxyPort
}

async function configureSession(frameKey: string): Promise<Session> {
  const sess = electronSession.fromPartition(pluginFramePartition(frameKey))
  const port = await startRefusingProxy()
  // Why `<-loopback>`: Chromium bypasses proxies for loopback by default, which would let
  // TURN-over-TCP reach local listeners directly.
  await sess.setProxy({
    mode: 'fixed_servers',
    proxyRules: `127.0.0.1:${port}`,
    proxyBypassRules: '<-loopback>'
  })
  if (!sess.protocol.isProtocolHandled(PLUGIN_FRAME_SCHEME)) {
    sess.protocol.handle(
      PLUGIN_FRAME_SCHEME,
      createPluginFrameRequestHandler(
        {
          findApprovedPluginByFrameKey,
          currentTheme: currentPluginFrameThemeSnapshot,
          log: (pluginKey, line) => console.warn(`[plugins] ${pluginKey}: ${line}`),
          readDeclarativeRuntime
        },
        frameKey
      )
    )
  }
  applyPluginFrameSessionPolicies(sess, frameKey)
  await sess.closeAllConnections()
  keyBySession.set(sess, frameKey)
  readyKeys.add(frameKey)
  return sess
}

function ensureSession(frameKey: string): Promise<Session> {
  let pending = sessionsByKey.get(frameKey)
  if (!pending) {
    pending = configureSession(frameKey).catch((error: unknown) => {
      sessionsByKey.delete(frameKey)
      throw error
    })
    sessionsByKey.set(frameKey, pending)
  }
  return pending
}

// Why the app path: resources/ ships inside app.asar, and dev and e2e run from the checkout.
function readDeclarativeRuntime(): Promise<Uint8Array> {
  return readFile(join(app.getAppPath(), 'resources', 'plugins', 'declarative', 'orca-runtime.mjs'))
}

/** The URL a contribution's guest loads: its HTML entry, or Orca's host page for a module. */
function contributionUrl(
  plugin: ValidDiscoveredPlugin,
  frameKey: string,
  surface: PluginFrameSurface,
  contributionId: string
): string | null {
  if (surface === 'editor') {
    const editor = plugin.manifest.contributes.customEditors.find(
      (entry) => entry.id === contributionId
    )
    return editor ? pluginFrameUrl(frameKey, editor.entry) : null
  }
  const panel = plugin.manifest.contributes.panels.find((entry) => entry.id === contributionId)
  if (!panel) {
    return null
  }
  return panel.ui === 'components'
    ? pluginDeclarativeHostUrl(frameKey, panel.entry)
    : pluginFrameUrl(frameKey, panel.entry)
}

// Part of the guest URL, so an update or a dev edit remounts the guest, and nothing else does.
function withRevision(url: string, plugin: ValidDiscoveredPlugin): string {
  const revision = pluginFrameContentRevision(plugin)
  return `${url}${url.includes('?') ? '&' : '?'}rev=${encodeURIComponent(revision)}`
}

/** Where a desktop frame loads; null when isolation is unavailable (the caller fails closed). */
export async function preparePluginFrameGuest(
  pluginKey: string,
  surface: PluginFrameSurface,
  contributionId: string
): Promise<PluginFrameGuest | null> {
  const plugin = source?.findApprovedPlugin(pluginKey) ?? null
  const frameKey = pluginFrameKey(pluginKey)
  pluginKeyByFrameKey.set(frameKey, pluginKey)
  const entryUrl = plugin ? contributionUrl(plugin, frameKey, surface, contributionId) : null
  if (!plugin || !entryUrl) {
    return null
  }
  const url = withRevision(entryUrl, plugin)
  try {
    // Why before answering: the guest must never start on a session whose proxy is not pinned.
    await ensureSession(frameKey)
  } catch (error) {
    console.warn(`[plugins] isolated frame session for ${pluginKey} is unavailable:`, error)
    return null
  }
  return {
    partition: pluginFramePartition(frameKey),
    url,
    ...(plugin.isDev ? { dev: true as const } : {})
  }
}

function admitAttach(partition: string, src: string): boolean {
  const frameKey = pluginFrameAttachKey(readPluginFramePartitionKey(partition), src)
  return (
    frameKey !== null && readyKeys.has(frameKey) && findApprovedPluginByFrameKey(frameKey) !== null
  )
}

function attachGuest(guest: WebContents, host: WebContents): boolean {
  const frameKey = keyBySession.get(guest.session)
  if (frameKey === undefined) {
    return false
  }
  installPluginFrameGuestPolicies(guest, frameKey, host, () => source?.getKeybindings?.())
  const pluginKey = pluginKeyByFrameKey.get(frameKey)
  if (pluginKey) {
    installPluginFrameGuestDiagnostics(guest, frameKey, pluginKey)
  }
  return true
}

setPluginFrameGuestHooks({ admit: admitAttach, attach: attachGuest })

/** A partition exists only once a frame of that plugin opened, in this run or an earlier one. */
function hasFramePartition(frameKey: string): boolean {
  return (
    sessionsByKey.has(frameKey) ||
    existsSync(join(app.getPath('userData'), 'Partitions', `orca-plugin-${frameKey}`))
  )
}

/** The partition's session keeps its handlers; a reinstall re-arms the rest through ensureSession. */
function forgetPluginFrameSession(pluginKey: string): void {
  const frameKey = pluginFrameKey(pluginKey)
  sessionsByKey.delete(frameKey)
  readyKeys.delete(frameKey)
  pluginKeyByFrameKey.delete(frameKey)
  killListCleared.delete(pluginKey)
}

/** Uninstall: the plugin's localStorage, IndexedDB, cookies and cache must not outlive it. */
export async function clearPluginFrameStorage(pluginKey: string): Promise<void> {
  try {
    // Why check first: fromPartition would create a partition a plugin never had.
    if (!hasFramePartition(pluginFrameKey(pluginKey))) {
      return
    }
    const sess = electronSession.fromPartition(pluginFramePartition(pluginFrameKey(pluginKey)))
    // Why first: a live guest would keep writing into storage being cleared.
    closePluginFrameGuests(sess)
    await Promise.all([sess.clearStorageData(), sess.clearCache()])
    forgetPluginFrameSession(pluginKey)
  } catch (error) {
    console.warn(`[plugins] could not clear frame storage for ${pluginKey}:`, error)
  }
}

/** After any plugin change: a disabled, unconsented or kill-listed plugin keeps no live guest,
 *  and a kill-listed one loses its storage too. */
export async function revokeUnapprovedPluginFrames(): Promise<void> {
  for (const [frameKey, pending] of sessionsByKey) {
    if (findApprovedPluginByFrameKey(frameKey)) {
      continue
    }
    let sess: Session
    try {
      sess = await pending
    } catch {
      // A session that never configured has no guests.
      continue
    }
    // Why re-check: an approval (e.g. a reinstall) can land while the session resolves, and its
    // fresh guest must survive this stale verdict.
    if (!findApprovedPluginByFrameKey(frameKey)) {
      closePluginFrameGuests(sess)
    }
  }
  await clearKillListedFrameStorage()
}

/** Every discovered plugin, not only this run's sessions: storage from an earlier run counts too. */
async function clearKillListedFrameStorage(): Promise<void> {
  for (const pluginKey of source?.listPluginKeys() ?? []) {
    if (source?.isKillListed?.(pluginKey) !== true) {
      // Leaving the kill list re-arms the one-time clear for a later listing.
      killListCleared.delete(pluginKey)
    } else if (!killListCleared.has(pluginKey)) {
      killListCleared.add(pluginKey)
      await clearPluginFrameStorage(pluginKey)
      // Clearing forgets the session, and with it the mark; keep it until the plugin leaves the list.
      killListCleared.add(pluginKey)
    }
  }
}
