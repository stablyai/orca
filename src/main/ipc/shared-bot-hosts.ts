// Window-only: this desktop's view of the agents shared with its Orca account, and its calls to their
// hosts. No runtime RPC reaches this, so no paired client can act as this account's share.
import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import type { SharedBotHostView } from '../../shared/bots/shared-bot-hosts'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import { SharedBotHosts } from '../bots/shared-with-me/shared-bot-hosts'
import { sharedBotsCloud } from '../bots/shared-with-me/shared-bots-cloud'
import { setSharedBotHostRouting } from '../bots/shared-with-me/shared-bot-host-routing'
import { SharedBotHomes, type SharedBotHomeDeps } from '../bots/shared-with-me/shared-bot-home'

const CallArgs = z.object({ environmentId: z.string().min(1), method: z.string().min(1) })
const SubscribeArgs = CallArgs.extend({ subscriptionId: z.string().min(1) })
const UnsubscribeArgs = z.object({ subscriptionId: z.string().min(1) })

export function registerSharedBotHostsHandlers(args: {
  userDataPath: string
  cloud: () => ConnectorCloud | null
  homes: Omit<SharedBotHomeDeps, 'userDataPath'>
}): SharedBotHosts {
  const hosts = new SharedBotHosts({
    userDataPath: args.userDataPath,
    homes: new SharedBotHomes({ ...args.homes, userDataPath: args.userDataPath }),
    platform: NODE_RELAY_CLIENT_PLATFORM,
    cloud: () => {
      const cloud = args.cloud()
      return cloud ? sharedBotsCloud(cloud) : null
    },
    publish: (views: SharedBotHostView[]) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) {
          window.webContents.send('sharedBotHosts:changed', views)
        }
      }
    }
  })
  // Each stream's release by its id; null while the host's subscribe is still settling.
  const subscriptions = new Map<string, (() => void) | null>()
  const release = (subscriptionId: string): void => {
    subscriptions.get(subscriptionId)?.()
    subscriptions.delete(subscriptionId)
  }
  const senderStreams = new WeakMap<Electron.WebContents, Set<string>>()
  for (const channel of [
    'sharedBotHosts:list',
    'sharedBotHosts:call',
    'sharedBotHosts:subscribe'
  ]) {
    ipcMain.removeHandler(channel)
  }
  // Answered once the kept shares are loaded, so the window never reads an empty list as "none".
  ipcMain.handle('sharedBotHosts:list', async () => {
    await hosts.ready()
    return hosts.views()
  })
  ipcMain.handle('sharedBotHosts:call', (_event, raw: { params?: unknown }) => {
    const { environmentId, method } = CallArgs.parse(raw)
    return hosts.call(environmentId, method, raw.params)
  })
  ipcMain.handle('sharedBotHosts:subscribe', async (event, raw: { params?: unknown }) => {
    const { environmentId, method, subscriptionId } = SubscribeArgs.parse(raw)
    const { sender } = event
    const channel = `sharedBotHosts:subscription:${subscriptionId}`
    release(subscriptionId)
    subscriptions.set(subscriptionId, null)
    let streams = senderStreams.get(sender)
    if (!streams) {
      const owned = new Set<string>()
      streams = owned
      senderStreams.set(sender, owned)
      sender.once('destroyed', () => owned.forEach(release))
    }
    streams.add(subscriptionId)
    const stop = await hosts.subscribe(environmentId, method, raw.params, (response) => {
      if (!sender.isDestroyed()) {
        sender.send(channel, response)
      }
    })
    // Released while the host was still answering: nothing is left to keep.
    if (subscriptions.has(subscriptionId)) {
      subscriptions.set(subscriptionId, stop)
    } else {
      stop()
    }
    return { subscribed: true }
  })
  ipcMain.removeAllListeners('sharedBotHosts:unsubscribe')
  ipcMain.on('sharedBotHosts:unsubscribe', (event, raw: unknown) => {
    const { subscriptionId } = UnsubscribeArgs.parse(raw)
    senderStreams.get(event.sender)?.delete(subscriptionId)
    release(subscriptionId)
  })
  setSharedBotHostRouting(hosts)
  hosts.start()
  return hosts
}
