// Window-only: this desktop's view of the agents shared with its Orca account. Their hosts are reached
// as paired servers through runtimeEnvironments (shared-host-keys.ts); this computer's own phones only
// ask for keys of their own (bots-share-phone.ts).
import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { BotShareIdSchema } from '../../shared/bots/bot-team-shares'
import type { SharedBotHostsState } from '../../shared/bots/shared-bot-hosts'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import { SharedBotHosts } from '../bots/shared-with-me/shared-bot-hosts'
import { sharedBotsCloud } from '../bots/shared-with-me/shared-bots-cloud'
import {
  reportingSharedBotsCloud,
  SharedBotHostFailures
} from '../bots/shared-with-me/shared-bot-host-failures'
import { setSharedHostsOwner } from './runtime-environments/requests/runtime-environment-shared-hosts'
import { setSharedHosts } from '../../shared/remote-runtime/pairing/shared-host-keys'
import { keptSharedHostRegistry } from '../bots/shared-with-me/shared-bot-host-key'
import {
  removeOldSharedBotHomes,
  type SharedBotHomeCleanupDeps
} from '../bots/shared-with-me/shared-bot-home-cleanup'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'

const ShareArgs = lazyZodSchema(() => z.object({ shareId: BotShareIdSchema }))
const SendAgainArgs = lazyZodSchema(() =>
  z.object({
    environmentId: z.string().min(1),
    clientMessageId: z.string().min(1)
  })
)

export function registerSharedBotHostsHandlers(args: {
  userDataPath: string
  cloud: () => ConnectorCloud | null
  homes: Pick<SharedBotHomeCleanupDeps, 'folderWorkspaceIds' | 'deleteFolderWorkspace'>
  /** The list this computer's phones read (sharedBots.phone.list) changed. */
  phoneSharesChanged: () => void
}): SharedBotHosts {
  const failures = new SharedBotHostFailures()
  const hosts = new SharedBotHosts({
    userDataPath: args.userDataPath,
    cloud: () => {
      const cloud = args.cloud()
      return cloud ? reportingSharedBotsCloud(sharedBotsCloud(cloud), failures) : null
    },
    failures,
    invites: args.cloud()?.invites ?? null,
    account: () => args.cloud()?.signedInAccount() ?? null,
    connectorOrigin: () => args.cloud()?.origin() ?? null,
    publish: (state: SharedBotHostsState) => {
      hosts.phones.noteListed(args.phoneSharesChanged)
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) {
          window.webContents.send('sharedBotHosts:changed', state)
        }
      }
    }
  })
  const channels = [
    'sharedBotHosts:list',
    'sharedBotHosts:sendAgain',
    'sharedBotHosts:accept',
    'sharedBotHosts:decline'
  ]
  for (const channel of channels) {
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
  ipcMain.handle('sharedBotHosts:accept', (_event, raw: unknown) =>
    hosts.accept(ShareArgs.parse(raw).shareId)
  )
  ipcMain.handle('sharedBotHosts:decline', (_event, raw: unknown) =>
    hosts.decline(ShareArgs.parse(raw).shareId)
  )
  setSharedHosts(
    keptSharedHostRegistry(
      hosts.store,
      () => hosts.listed(),
      () => hosts.ready()
    )
  )
  setSharedHostsOwner(hosts)
  // Started after it, so no refresh rewrites a share while its old home is removed.
  hosts.start(
    hosts
      .ready()
      .then(() =>
        removeOldSharedBotHomes({
          ...args.homes,
          userDataPath: args.userDataPath,
          store: hosts.store
        })
      )
      .catch((error: unknown) => console.warn('[shared-agents] old home cleanup failed', error))
  )
  return hosts
}
