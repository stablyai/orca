// The connector and what moves with it, on any host: the desktop app, Electron `orca serve` and orcad.
import { BotAvatarSync } from './bot-avatar-sync'
import { withBotsCloudClient } from './bots-cloud-client'
import { createConnectorCloud } from './connector-cloud-install'
import { ConnectorGitHubInstallations } from './connector-github-installations'
import type { ConnectorRuntimeKind } from './connector-machine'
import { connectorAccount } from './connector-token-mint'
import { botAccessHost } from '../bots/bot-access-host'
import { botAccessSeenFile, createBotAccessRequestWatch } from '../bots/bot-access-request-watch'
import { notifyBotCouldNotFinish, runtimeBotOwnerNotice } from '../bots/bot-could-not-finish'
import { WebhookHostService } from '../webhooks/webhook-host-service'
import { installComposioUpkeep } from '../runtime/rpc/methods/bots-composio-upkeep'
import { refreshDueLinearLogins } from '../linear/accounts/linear-login-refresh'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence/loading-store/store'
import { splitBotsByOlderBuildSupport, withGitHubMembersTagged } from '../../shared/bot-types'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../shared/orca-profiles/orca-cloud-team-policy'
import { onTeamFeatureBlockChanged } from '../orca-profiles/cloud-auth/active-team-capabilities'

const LINEAR_LOGIN_REFRESH_DELAY_MS = 30_000

export type ConnectorHostOptions = {
  runtime: OrcaRuntimeService
  store: Store
  /** This host's own data folder, so the connector mints as its own account and install id. */
  userDataPath: string
  /** From the caller: a server never says it is a desktop. */
  kind: ConnectorRuntimeKind
  /** Quitting or relaunching: nothing new starts. */
  isFenced: () => boolean
}

export type ConnectorHost = {
  gitHubInstallations: ConnectorGitHubInstallations
  /** Refreshes Connect Linear's logins that are near their end, e.g. once the computer wakes. */
  refreshLinearLogins: () => void
  /** Stops the host work's timers, for a host that stops without exiting. */
  stop: () => void
}

/**
 * Sets the runtime's connector before any account hook can fire. Install even while signed out:
 * the connector is null only without Orca Cloud auth config, so a later sign-in needs no reinstall.
 */
export function installConnectorHost({
  runtime,
  store,
  userDataPath,
  kind,
  isFenced
}: ConnectorHostOptions): ConnectorHost {
  const gitHubInstallations = new ConnectorGitHubInstallations({
    account: () => connectorAccount(userDataPath),
    fetchState: () =>
      withBotsCloudClient(runtime.getConnectorCloud(), (client) => client.githubState())
  })
  const warnDropped = (error: unknown) =>
    console.warn('[webhooks] could not drop a deleted hook from its automation', error)
  const botFolder = (botId: string): string | null => {
    const bot = store.getBots().find((entry) => entry.id === botId)
    const folder = store.getFolderWorkspaces().find((entry) => entry.id === bot?.folderWorkspaceId)
    // Bot homes live under this host's ~/.orca/bots; a remote path is never written as a local one.
    return folder && !folder.connectionId ? folder.folderPath : null
  }
  const webhooks = new WebhookHostService({
    userDataPath,
    account: () => connectorAccount(userDataPath),
    cloud: () => runtime.getConnectorCloud(),
    automations: {
      list: () => store.listAutomations(),
      runs: (automationId) => store.listAutomationRuns(automationId),
      setTriggers: (id, on) => {
        runtime.updateAutomation(id, { on }).catch(warnDropped)
      },
      remove: (id) => {
        runtime.deleteAutomation(id).catch(warnDropped)
      }
    },
    botFolder,
    botFolders: () =>
      store.getBots().flatMap((bot) => {
        const folder = botFolder(bot.id)
        return folder ? [folder] : []
      }),
    botExists: (botId) => store.getBots().some((entry) => entry.id === botId),
    newerAgentBotIds: () =>
      new Set(splitBotsByOlderBuildSupport(store.getBots()).newer.map((bot) => bot.id)),
    bot: (botId) => store.getBots().find((entry) => entry.id === botId),
    notifyOwner: (bot, automation, notice) =>
      notifyBotCouldNotFinish(runtimeBotOwnerNotice(runtime), bot, automation, notice),
    runForEvent: (automationId, event, gate) =>
      runtime.runAutomationForEvent(automationId, event, gate)
  })
  runtime.setConnectorCloud(
    createConnectorCloud({
      runtime,
      store,
      userDataPath,
      kind,
      isFenced,
      gitHubInstallations,
      webhooks
    })
  )
  const stops: (() => void)[] = []
  // Only a host with Orca Cloud makes webhooks, as it alone hosts the connector.
  const connector = runtime.getConnectorCloud()
  if (connector) {
    runtime.setWebhooks(webhooks)
    const composio = installComposioUpkeep(runtime, webhooks)
    stops.push(
      () => webhooks.stop(),
      () => composio.stop(),
      onTeamFeatureBlockChanged(ORCA_CLOUD_TEAM_POLICY_FLAGS.bots, () => {
        connector.helloInputsChanged()
        runtime.notifyBotsChanged({ kinds: ['settings', 'bot'] })
      })
    )
    runtime.onClientEvent(
      (event) => {
        if (event.type === 'automationsChanged' || event.type === 'reposChanged') {
          webhooks.changed()
        }
        // A deleted bot, hook or automation leaves Composio triggers to remove.
        if (event.type === 'automationsChanged') {
          composio.soon()
        }
      },
      { consumesTerminalSideEffects: false }
    )
    runtime.onBotsWritten(() => webhooks.botsWritten())
    void webhooks.start()
  }
  // Once the account's orgs are known, people saved before orgs had rows go in each of them.
  gitHubInstallations.onChange(() => {
    const ids = gitHubInstallations.ids()
    for (const bot of store.getBots()) {
      if (withGitHubMembersTagged(bot, ids) !== bot) {
        runtime.bots
          .update(bot.id, (saved) => ({ members: withGitHubMembersTagged(saved, ids).members }))
          .catch((error: unknown) => console.warn('[bots] could not tag GitHub people', error))
      }
    }
  })
  const avatars = new BotAvatarSync({
    bots: runtime.bots,
    cloud: () => runtime.getConnectorCloud()
  })
  runtime.onBotsWritten(() => avatars.changed())
  stops.push(runtime.bots.slackIcons.onStored((botId) => avatars.iconStored(botId)))
  // Turning bots on or off runs a pass of the pictures.
  stops.push(
    store.onSettingsChanged((updates) => {
      // On, what was owed goes; off, the bytes kept for retries are let go. Clients hear it too, so a
      // window that this host told its bots were off asks for their drawings again.
      if (updates.botsEnabled !== undefined) {
        avatars.changed()
        runtime.notifyBotsChanged({ kinds: ['settings'] })
      }
    })
  )
  // A team turning bots on or off, Orca Cloud answering again, or a sign-in: each is a real step for the
  // pictures, so one that failed to send goes then.
  stops.push(onTeamFeatureBlockChanged(ORCA_CLOUD_TEAM_POLICY_FLAGS.bots, () => avatars.changed()))
  if (connector) {
    stops.push(connector.onBack((why) => avatars.retryOwed(why)))
  }
  avatars.changed()
  // The host's store of Request access asks for its bots: their list, and the phones' push of new ones.
  const accessWatch = createBotAccessRequestWatch({
    ...botAccessHost(runtime),
    botsEnabled: () => runtime.bots.enabled(),
    notify: runtimeBotOwnerNotice(runtime).notify,
    changed: () => runtime.notifyBotAccessRequestsChanged(),
    seen: botAccessSeenFile(userDataPath),
    now: () => Date.now()
  })
  runtime.botAccessWatch = accessWatch
  runtime.connectorGitHubInstallations = gitHubInstallations
  stops.push(accessWatch.start())
  // Connect Linear's login lasts a day: refresh it after startup's rush, and on wake where the host says.
  const refreshLinearLogins = () => {
    refreshDueLinearLogins().catch((error: unknown) =>
      console.warn('[linear] login refresh failed', error)
    )
  }
  setTimeout(refreshLinearLogins, LINEAR_LOGIN_REFRESH_DELAY_MS).unref?.()
  return {
    gitHubInstallations,
    refreshLinearLogins,
    stop: () => stops.splice(0).forEach((stop) => stop())
  }
}
