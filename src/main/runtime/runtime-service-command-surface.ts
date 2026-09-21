import type { RuntimeAccountController } from './runtime-account-controller'
import type { RuntimeAiVaultCommands } from './runtime-ai-vault-commands'
import type { RuntimeBrowserDriverController } from './runtime-browser-driver-controller'
import type { RuntimeClientEventBus } from './runtime-client-event-bus'
import type { RuntimeMessageWaiters } from './runtime-message-waiters'
import type { RuntimeMobileDictationController } from './runtime-mobile-dictation-controller'
import type { RuntimeMobileNotificationController } from './runtime-mobile-notification-controller'
import type { RuntimeMobileSpeechCatalog } from './runtime-mobile-speech-catalog'
import type { RuntimeNativeChatDraftResolutions } from './runtime-native-chat-draft-resolutions'
import type { RuntimeSubscriptionRegistry } from './runtime-subscription-registry'

export type RuntimeServiceCommandSurface = {
  listAiVaultSessions: RuntimeAiVaultCommands['list']
  resolveAiVaultSessionTitles: RuntimeAiVaultCommands['resolveTitles']
  prepareAiVaultSessionResume: RuntimeAiVaultCommands['prepare']
  onClientEvent: RuntimeClientEventBus['on']
  notifyNativeChatLaunchDraftResolved: RuntimeNativeChatDraftResolutions['notify']
  registerSubscriptionCleanup: RuntimeSubscriptionRegistry['register']
  registerOwnedSubscriptionCleanup: RuntimeSubscriptionRegistry['registerOwned']
  cleanupSubscription: RuntimeSubscriptionRegistry['cleanup']
  retrySubscriptionCleanupAfter: RuntimeSubscriptionRegistry['retryAfter']
  cleanupSubscriptionAndWait: RuntimeSubscriptionRegistry['cleanupAndWait']
  cleanupSubscriptionsByPrefix: RuntimeSubscriptionRegistry['cleanupByPrefix']
  cleanupSubscriptionsForConnection: RuntimeSubscriptionRegistry['cleanupForConnection']
  cleanupSubscriptionIfOwnedByConnection: RuntimeSubscriptionRegistry['cleanupIfOwnedByConnection']
  onNotificationDispatched: RuntimeMobileNotificationController['onDispatched']
  getMobileNotificationListenerCount: RuntimeMobileNotificationController['getListenerCount']
  dispatchMobileNotification: RuntimeMobileNotificationController['dispatch']
  getMissedNotificationsSince: RuntimeMobileNotificationController['getMissedSince']
  getMobileNotificationEpoch: RuntimeMobileNotificationController['getEpoch']
  dismissMobileNotification: RuntimeMobileNotificationController['dismiss']
  dispatchPluginNotification: RuntimeMobileNotificationController['dispatchPlugin']
  setAccountServices: RuntimeAccountController['setServices']
  setCommitMessageAgentEnvironmentResolvers: RuntimeAccountController['setCommitMessageAgentEnvironment']
  getCommitMessageAgentEnvironmentResolvers: RuntimeAccountController['getCommitMessageAgentEnvironment']
  getAccountsSnapshot: RuntimeAccountController['getSnapshot']
  refreshAccountsForMobile: RuntimeAccountController['refreshForMobile']
  refreshAccountsForMobileSubscriber: RuntimeAccountController['refreshForMobileSubscriber']
  selectClaudeAccount: RuntimeAccountController['selectClaude']
  selectCodexAccount: RuntimeAccountController['selectCodex']
  selectCodexAccountForTarget: RuntimeAccountController['selectCodexForTarget']
  consumeCodexRateLimitResetCredit: RuntimeAccountController['consumeCodexResetCredit']
  removeClaudeAccount: RuntimeAccountController['removeClaude']
  addClaudeAccountFromConfigDir: RuntimeAccountController['addClaudeFromConfigDir']
  removeCodexAccount: RuntimeAccountController['removeCodex']
  addCodexAccountFromHome: RuntimeAccountController['addCodexFromHome']
  onAccountsChanged: RuntimeAccountController['onChanged']
  listMobileSpeechModels: RuntimeMobileSpeechCatalog['list']
  downloadMobileSpeechModel: RuntimeMobileSpeechCatalog['download']
  deleteMobileSpeechModel: RuntimeMobileSpeechCatalog['delete']
  configureMobileDictation: RuntimeMobileSpeechCatalog['configure']
  startMobileDictation: RuntimeMobileDictationController['start']
  feedMobileDictation: RuntimeMobileDictationController['feed']
  finishMobileDictation: RuntimeMobileDictationController['finish']
  cancelMobileDictation: RuntimeMobileDictationController['cancel']
  cancelMobileDictationForConnection: RuntimeMobileDictationController['cancelForConnection']
  getAllBrowserDrivers: RuntimeBrowserDriverController['getAll']
  reclaimBrowserForDesktop: RuntimeBrowserDriverController['reclaimForDesktop']
  notifyMessageArrived(handle: string, messageType?: string): void
  waitForMessage: RuntimeMessageWaiters['wait']
  cancelMessageWaiters: RuntimeMessageWaiters['cancel']
}

type RuntimeServiceCommandOwners = {
  aiVault: RuntimeAiVaultCommands
  clientEvents: RuntimeClientEventBus
  nativeChatDraftResolutions: RuntimeNativeChatDraftResolutions
  subscriptions: RuntimeSubscriptionRegistry
  mobileNotifications: RuntimeMobileNotificationController
  accounts: RuntimeAccountController
  mobileSpeech: RuntimeMobileSpeechCatalog
  mobileDictation: RuntimeMobileDictationController
  browserDrivers: RuntimeBrowserDriverController
  messageWaiters: RuntimeMessageWaiters
}

export function installRuntimeServiceCommandSurface(
  target: RuntimeServiceCommandSurface,
  owners: RuntimeServiceCommandOwners
): void {
  const vault = owners.aiVault
  const events = owners.clientEvents
  const drafts = owners.nativeChatDraftResolutions
  const subscriptions = owners.subscriptions
  const notifications = owners.mobileNotifications
  const accounts = owners.accounts
  const speech = owners.mobileSpeech
  const dictation = owners.mobileDictation
  const browsers = owners.browserDrivers
  const waiters = owners.messageWaiters
  Object.assign(target, {
    listAiVaultSessions: vault.list.bind(vault),
    resolveAiVaultSessionTitles: vault.resolveTitles.bind(vault),
    prepareAiVaultSessionResume: vault.prepare.bind(vault),
    onClientEvent: events.on.bind(events),
    notifyNativeChatLaunchDraftResolved: drafts.notify.bind(drafts),
    registerSubscriptionCleanup: subscriptions.register.bind(subscriptions),
    registerOwnedSubscriptionCleanup: subscriptions.registerOwned.bind(subscriptions),
    cleanupSubscription: subscriptions.cleanup.bind(subscriptions),
    retrySubscriptionCleanupAfter: subscriptions.retryAfter.bind(subscriptions),
    cleanupSubscriptionAndWait: subscriptions.cleanupAndWait.bind(subscriptions),
    cleanupSubscriptionsByPrefix: subscriptions.cleanupByPrefix.bind(subscriptions),
    cleanupSubscriptionsForConnection: subscriptions.cleanupForConnection.bind(subscriptions),
    cleanupSubscriptionIfOwnedByConnection:
      subscriptions.cleanupIfOwnedByConnection.bind(subscriptions),
    onNotificationDispatched: notifications.onDispatched.bind(notifications),
    getMobileNotificationListenerCount: notifications.getListenerCount.bind(notifications),
    dispatchMobileNotification: notifications.dispatch.bind(notifications),
    getMissedNotificationsSince: notifications.getMissedSince.bind(notifications),
    getMobileNotificationEpoch: notifications.getEpoch.bind(notifications),
    dismissMobileNotification: notifications.dismiss.bind(notifications),
    dispatchPluginNotification: notifications.dispatchPlugin.bind(notifications),
    setAccountServices: accounts.setServices.bind(accounts),
    setCommitMessageAgentEnvironmentResolvers:
      accounts.setCommitMessageAgentEnvironment.bind(accounts),
    getCommitMessageAgentEnvironmentResolvers:
      accounts.getCommitMessageAgentEnvironment.bind(accounts),
    getAccountsSnapshot: accounts.getSnapshot.bind(accounts),
    refreshAccountsForMobile: accounts.refreshForMobile.bind(accounts),
    refreshAccountsForMobileSubscriber: accounts.refreshForMobileSubscriber.bind(accounts),
    selectClaudeAccount: accounts.selectClaude.bind(accounts),
    selectCodexAccount: accounts.selectCodex.bind(accounts),
    selectCodexAccountForTarget: accounts.selectCodexForTarget.bind(accounts),
    consumeCodexRateLimitResetCredit: accounts.consumeCodexResetCredit.bind(accounts),
    removeClaudeAccount: accounts.removeClaude.bind(accounts),
    addClaudeAccountFromConfigDir: accounts.addClaudeFromConfigDir.bind(accounts),
    removeCodexAccount: accounts.removeCodex.bind(accounts),
    addCodexAccountFromHome: accounts.addCodexFromHome.bind(accounts),
    onAccountsChanged: accounts.onChanged.bind(accounts),
    listMobileSpeechModels: speech.list.bind(speech),
    downloadMobileSpeechModel: speech.download.bind(speech),
    deleteMobileSpeechModel: speech.delete.bind(speech),
    configureMobileDictation: speech.configure.bind(speech),
    startMobileDictation: dictation.start.bind(dictation),
    feedMobileDictation: dictation.feed.bind(dictation),
    finishMobileDictation: dictation.finish.bind(dictation),
    cancelMobileDictation: dictation.cancel.bind(dictation),
    cancelMobileDictationForConnection: dictation.cancelForConnection.bind(dictation),
    getAllBrowserDrivers: browsers.getAll.bind(browsers),
    reclaimBrowserForDesktop: browsers.reclaimForDesktop.bind(browsers),
    waitForMessage: waiters.wait.bind(waiters),
    cancelMessageWaiters: waiters.cancel.bind(waiters)
  })
}
