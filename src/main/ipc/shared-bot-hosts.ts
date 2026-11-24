// Window-only: this desktop's view of the agents shared with its Orca account, and its calls to their
// hosts. No runtime RPC reaches this, so no paired client can act as this account's share.
import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import type { SharedBotHostView } from '../../shared/bots/shared-bot-hosts'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import { SharedBotHosts } from '../bots/shared-with-me/shared-bot-hosts'
import { sharedBotsCloud } from '../bots/shared-with-me/shared-bots-cloud'

const CallArgs = z.object({ environmentId: z.string().min(1), method: z.string().min(1) })
const SubscribeArgs = CallArgs.extend({ subscriptionId: z.string().min(1) })
const UnsubscribeArgs = z.object({ subscriptionId: z.string().min(1) })

export function registerSharedBotHostsHandlers(args: {
  userDataPath: string
  cloud: () => ConnectorCloud | null
}): SharedBotHosts {
  const hosts = new SharedBotHosts({
    userDataPath: args.userDataPath,
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
  const subscriptions = new Map<string, () => void>()
  for (const channel of [
    'sharedBotHosts:list',
    'sharedBotHosts:call',
    'sharedBotHosts:subscribe'
  ]) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('sharedBotHosts:list', () => hosts.views())
  ipcMain.handle('sharedBotHosts:call', (_event, raw: { params?: unknown }) => {
    const { environmentId, method } = CallArgs.parse(raw)
    return hosts.call(environmentId, method, raw.params)
  })
  ipcMain.handle('sharedBotHosts:subscribe', async (event, raw: { params?: unknown }) => {
    const { environmentId, method, subscriptionId } = SubscribeArgs.parse(raw)
    const channel = `sharedBotHosts:subscription:${subscriptionId}`
    subscriptions.get(subscriptionId)?.()
    const release = await hosts.subscribe(environmentId, method, raw.params, (response) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, response)
      }
    })
    subscriptions.set(subscriptionId, release)
    event.sender.once('destroyed', () => {
      subscriptions.get(subscriptionId)?.()
      subscriptions.delete(subscriptionId)
    })
    return { subscribed: true }
  })
  ipcMain.removeAllListeners('sharedBotHosts:unsubscribe')
  ipcMain.on('sharedBotHosts:unsubscribe', (_event, raw: unknown) => {
    const { subscriptionId } = UnsubscribeArgs.parse(raw)
    subscriptions.get(subscriptionId)?.()
    subscriptions.delete(subscriptionId)
  })
  hosts.start()
  return hosts
}
