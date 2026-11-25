// Window-only: this desktop's view of the agents shared with its Orca account. Calls and streams to
// their hosts go through runtimeEnvironments, which routes them here; this computer's own phones only
// ask for keys of their own (bots-share-phone.ts).
import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import type { SharedBotHostsState } from '../../shared/bots/shared-bot-hosts'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import { SharedBotHosts } from '../bots/shared-with-me/shared-bot-hosts'
import { sharedBotsCloud } from '../bots/shared-with-me/shared-bots-cloud'
import {
  reportingSharedBotsCloud,
  SharedBotHostFailures
} from '../bots/shared-with-me/shared-bot-host-failures'
import {
  routeSharedHostsThrough,
  sharedHostsChanged
} from './runtime-environments/requests/runtime-environment-shared-hosts'
import { SharedBotHomes, type SharedBotHomeDeps } from '../bots/shared-with-me/shared-bot-home'
import { isBotShareMethod, isBotShareStreamMethod } from '../runtime/rpc/methods/rpc-method-share'

const SendAgainArgs = z.object({
  environmentId: z.string().min(1),
  clientMessageId: z.string().min(1)
})

export function registerSharedBotHostsHandlers(args: {
  userDataPath: string
  cloud: () => ConnectorCloud | null
  homes: Omit<SharedBotHomeDeps, 'userDataPath'>
  /** The list this computer's phones read (sharedBots.phone.list) changed. */
  phoneSharesChanged: () => void
}): SharedBotHosts {
  const failures = new SharedBotHostFailures()
  const hosts = new SharedBotHosts({
    userDataPath: args.userDataPath,
    homes: new SharedBotHomes({ ...args.homes, userDataPath: args.userDataPath }),
    platform: NODE_RELAY_CLIENT_PLATFORM,
    cloud: () => {
      const cloud = args.cloud()
      return cloud ? reportingSharedBotsCloud(sharedBotsCloud(cloud), failures) : null
    },
    failures,
    account: () => args.cloud()?.signedInAccount() ?? null,
    connectorOrigin: () => args.cloud()?.origin() ?? null,
    publish: (state: SharedBotHostsState) => {
      sharedHostsChanged()
      hosts.phones.noteListed(args.phoneSharesChanged)
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) {
          window.webContents.send('sharedBotHosts:changed', state)
        }
      }
    }
  })
  for (const channel of ['sharedBotHosts:list', 'sharedBotHosts:sendAgain']) {
    ipcMain.removeHandler(channel)
  }
  // Answered once the kept shares are loaded, so the window never reads an empty list as "none".
  ipcMain.handle('sharedBotHosts:list', async () => {
    await hosts.ready()
    return hosts.state()
  })
  ipcMain.handle('sharedBotHosts:sendAgain', (_event, raw: unknown) => {
    const { environmentId, clientMessageId } = SendAgainArgs.parse(raw)
    return hosts.sendAgain(environmentId, clientMessageId)
  })
  routeSharedHostsThrough({
    hosts,
    methods: { allows: isBotShareMethod, streams: isBotShareStreamMethod }
  })
  hosts.start()
  return hosts
}
