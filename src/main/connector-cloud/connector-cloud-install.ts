import type { ConnectorCloudFeature } from '../../shared/connectors/connector-cloud-contract'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import { getOrcaCloudAuthConfig } from '../orca-profiles/cloud-auth/profile-cloud-auth-config'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import { ConnectorCloud } from './connector-cloud'
import { resolveConnectorOrigin } from './connector-origin'
import type { ConnectorGitHubInstallations } from './connector-github-installations'
import type { ConnectorRuntimeKind } from './connector-machine'
import { connectorBots, type ConnectorPlacesStore } from './connector-places'
import { connectorAccount, desktopConnectorTokenMint } from './connector-token-mint'
import { connectorTriggers, triggerRunEvent } from './connector-triggers'
import { hostNeedsConnector } from './connector-connection-need'
import type { WebhookHostService } from '../webhooks/webhook-host-service'
import { botPlaceMigrationOnHello } from '../automations/bot-automation-ref-migration'
import { turnAutomations } from './connector-turn-automations'
import { eventRun, takingAutomation } from '../automations/automation-trigger-runs'
import { BotPrWaker } from '../bots/bot-pr-events'
import { cancelConnectorConnectsForAccountChange } from './connector-connect'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { readDispatchWorkers } from '../runtime/rpc/methods/orchestration/worker/session-workers-method'
import { runOwnPrGuarded, type OwnPrGuardDeps } from './own-pr-trigger-guard'
import { handleThreadMute, type ThreadMuteDeps } from './connector-thread-mute'
import { threadMuteSaves } from './connector-thread-mute-saves'
import { postConnectorAction } from './connector-actions'
import { readThreadMute } from '../external-conversations/external-conversation-link-writes'
import type { ExternalConversationLinkStore } from '../external-conversations/external-conversation-links'

// A slow GitHub read holds the first hello only this long; a later answer still says a new one.
const FIRST_GITHUB_ANSWER_WAIT_MS = 3_000

export type ConnectorCloudStore = ConnectorPlacesStore &
  ExternalConversationLinkStore &
  Pick<RuntimeStore, 'getSettings' | 'onSettingsChanged' | 'flushPendingOrThrowAsync'> &
  Required<Pick<RuntimeStore, 'listAutomations' | 'listAutomationRuns'>>

export type ConnectorCloudHost = {
  runtime: OrcaRuntimeService
  store: ConnectorCloudStore
  /** This host's own data folder: its Orca account and install id, never another computer's. */
  userDataPath: string
  kind: ConnectorRuntimeKind
  isFenced: () => boolean
  gitHubInstallations: ConnectorGitHubInstallations
  webhooks: Pick<
    WebhookHostService,
    'receive' | 'notice' | 'helloAnswered' | 'pausing' | 'onConfirmed'
  >
}

/** The connector acts as this host's own signed-in Orca account; null without Orca Cloud auth config. */
export function createConnectorCloud({
  runtime,
  store,
  userDataPath,
  kind,
  isFenced,
  gitHubInstallations,
  webhooks
}: ConnectorCloudHost): ConnectorCloud | null {
  const auth = getOrcaCloudAuthConfig()
  if (!auth.configured) {
    return null
  }
  const environment = getAppEnvironment()
  const migratePlaces = botPlaceMigrationOnHello(
    {
      list: () => store.listAutomations(),
      update: (id, patch, unchangedSince) => runtime.updateAutomation(id, patch, { unchangedSince })
    },
    () => runtime.getConnectorCloud()?.refResolver() ?? null
  )
  const prWaker = new BotPrWaker({
    record: runtime.botWork,
    store: () => runtime.botWork.store().wakes,
    now: Date.now,
    send: (address, deliveryId, message) => {
      const seam = runtime.getExternalConversationSeam()
      if (!seam) {
        throw new Error('connectors_disabled')
      }
      return seam.send(runtimeConversationHost(runtime), address, deliveryId, message)
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
    // A chat worker's newest journal write, else when its Dispatch settled. Only this host's workers
    // match a PR today, so a paired server's never reach here.
    workerActivity: async (dispatchId) => {
      const [worker] = await readDispatchWorkers(runtime, [dispatchId])
      if (!worker) {
        return null
      }
      const chat = getStructuredAgentSessionHost()
      const lastWrite =
        worker.chatSessionId && chat
          ? await chat.conversation(worker.chatSessionId).then(
              (session) => session.journal.reads.lastActivityAt(),
              () => 0
            )
          : 0
      return {
        working: worker.state === 'working',
        lastActiveAt: lastWrite > 0 ? lastWrite : worker.settledAt
      }
    }
  })
  // Batches held when Orca last quit go out when due.
  prWaker.resume()
  const ownPrGuard: OwnPrGuardDeps = {
    isBotWork: (pr) => runtime.isBotWorkPullRequest(pr),
    runs: (automationId) => store.listAutomationRuns(automationId)
  }
  const muteDeps = threadMuteDeps(runtime, store)
  return new ConnectorCloud({
    userDataPath,
    origin: resolveConnectorOrigin(process.env, environment.isPackaged()),
    isFenced,
    account: () => connectorAccount(userDataPath),
    mintFor: (account) => desktopConnectorTokenMint(auth.config, userDataPath, account),
    onStatusChanged: () => runtime.notifyBotsChanged({ kinds: ['settings'] }),
    onAccountSwitched: cancelConnectorConnectsForAccountChange,
    replyJournal: () => getStructuredAgentSessionHost()?.deps.store.connectorReplies() ?? null,
    machine: {
      runtime: kind,
      orcaVersion: environment.getVersion(),
      hostName: () => runtime.readMachineName(),
      seam: () => runtime.getExternalConversationSeam(),
      resetConversations: () => runtime.getExternalConversationSeam()?.resetAccount(),
      conversationHost: () => runtimeConversationHost(runtime),
      bots: () =>
        connectorBots(
          store,
          store.getSettings().botsEnabled !== false,
          // Asks the cloud only for an account with a bot on GitHub.
          (store.getBots?.() ?? []).some((bot) => bot.github) ? gitHubInstallations.ids() : [],
          runtime.getConnectorCloud()?.cloudFeatures() ?? null
        ),
      beforeFirstHello: async () => {
        await Promise.all([
          runtime.machineNameReady(),
          (store.getBots?.() ?? []).some((bot) => bot.github)
            ? gitHubInstallations.firstAnswer(FIRST_GITHUB_ANSWER_WAIT_MS)
            : undefined
        ])
      },
      triggers: () =>
        connectorTriggers(store.listAutomations(), (hookId) => webhooks.pausing(hookId)),
      runTrigger: async (delivery) => {
        const event = triggerRunEvent(store.listAutomations(), store.getBots?.() ?? [], delivery)
        if (event?.source === 'webhook') {
          // Its ledger, not the run, confirms a call.
          return webhooks.receive(delivery, event)
        }
        if (!event) {
          return false
        }
        // The owner's own pull request starts nothing when the bot's own work opened it as them.
        return runOwnPrGuarded(
          ownPrGuard,
          (id, runEvent, gate) => runtime.runAutomationForEvent(id, runEvent, gate),
          event,
          delivery
        )
      },
      turnAutomations: (entries) =>
        turnAutomations(store.listAutomations(), store.getBots?.() ?? [], entries, {
          takes: (id, event) =>
            takingAutomation(store, id, event) !== null && !eventRun(store, id, event),
          run: (id, event, inTurn) => runtime.runAutomationForEvent(id, event, inTurn)
        }),
      // Connectors off: no seam, so no bot thread to mute.
      threadMute: (delivery, record, carriedBefore) =>
        runtime.getExternalConversationSeam()
          ? handleThreadMute(muteDeps, delivery, record, carriedBefore)
          : null,
      webhookNotice: async (delivery) => webhooks.notice(delivery),
      prEvent: (delivery) => prWaker.handle(delivery.deliveryId, delivery.event),
      helloAnswered: (answer) => {
        webhooks.helloAnswered(answer)
        migratePlaces()
      },
      wantsConnection: () =>
        hostNeedsConnector(
          store.getBots?.() ?? [],
          connectorTriggers(store.listAutomations(), (hookId) => webhooks.pausing(hookId))
        ),
      onHelloInputsChanged: (listener) => {
        runtime.onBotsWritten(listener)
        runtime.onClientEvent(
          (event) => {
            if (event.type === 'reposChanged' || event.type === 'automationsChanged') {
              listener()
            }
          },
          { consumesTerminalSideEffects: false }
        )
        store.onSettingsChanged?.(() => listener())
        gitHubInstallations.onChange(listener)
        webhooks.onConfirmed(listener)
      }
    }
  })
}

/** A bot thread's mute as its link keeps it, and its emoji posted as the bot. */
function threadMuteDeps(runtime: OrcaRuntimeService, store: ConnectorCloudStore): ThreadMuteDeps {
  return {
    waiting: new Map(),
    read: (key) => readThreadMute(store, key),
    write: threadMuteSaves(store),
    queued: (key, work) =>
      runtime.getExternalConversationSeam()?.queued(key, work) ??
      Promise.resolve(work?.()).then(() => undefined),
    botNames: (botId) => {
      const bot = store.getBots?.().find((entry) => entry.id === botId)
      return bot ? [bot.name] : []
    },
    react: async (botId, conversation, ref, emoji) => {
      const cloud = runtime.getConnectorCloud()
      if (!cloud?.cloudFeatures()?.has('actions' satisfies ConnectorCloudFeature)) {
        return
      }
      const answer = await postConnectorAction(
        cloud,
        { botId, verb: 'react', ref, args: { emoji }, conversation },
        new AbortController().signal
      )
      if (!answer.ok || !answer.value.ok) {
        throw new Error(`react_failed: ${JSON.stringify(answer)}`)
      }
    }
  }
}
