import { app } from 'electron'
import { KeybindingService } from '../keybindings/keybinding-service'
import { createProviderAccountServices } from '../providers/accounts/provider-account-services'
import { createCodexSessionMigrationScheduler } from '../codex/history/backfill/codex-session-migration-scheduler'
import { startCodexSessionBackfillInBackground } from '../codex/history/backfill/codex-session-backfill'
import { startCodexSessionIndexHealInBackground } from '../codex/history/index/codex-session-index-heal'
import { startCodexStateDbBackfillRecoveryInBackground } from '../codex/history/index/codex-state-db-backfill-recovery'
import { getOrcaManagedCodexHomePath } from '../codex/configuration/homes/codex-home-paths'
import {
  hasOpenCodeGoApiKey,
  readOpenCodeGoApiKey,
  saveOpenCodeGoApiKey
} from '../opencode/opencode-go-api-key-store'
import { agentHookServer } from '../agent-hooks/server'
import { resolveHostCodexSessionSourceHome } from '../codex/history/rollouts/codex-session-source-home'
import { browserManager } from '../browser/browser-manager'
import { prewarmStructuredAgentModelCatalogs } from '../runtime/agent-session/model-catalog/structured-agent-model-catalog-wiring'
import { getRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import { translateMain } from '../i18n/main-i18n'
import { dispatchClaudeRecentMoves } from '../claude-accounts/claude-session-move-mobile-notice'
import type {
  ClaudeAutoSwitchedEvent,
  ClaudePaneAssignedEvent
} from '../../shared/managed-account-types'
import { claudeAccountShortLabel } from '../claude-accounts/claude-account-short-label'
import {
  onClaudePaneAssigned,
  type ClaudePaneAssignedNotice
} from '../claude-accounts/claude-pane-account-registry'
import { startClaudeAuthProxy } from '../claude-accounts/claude-auth-proxy/claude-auth-proxy-host'
import { mainProcessState as state } from './main-process-state'

// Settings that change which account or binary a new chat's agent runs under.
const MODEL_CATALOG_ACCOUNT_SETTINGS = [
  'activeCodexManagedAccountId',
  'activeCodexManagedAccountIdsByRuntime',
  'codexManagedAccounts',
  'activeClaudeManagedAccountId',
  'activeClaudeManagedAccountIdsByRuntime',
  'claudeManagedAccounts',
  'agentDefaultEnv',
  'agentCmdOverrides'
] as const

export function initializeMainProcessAccountServices(): void {
  const store = state.store
  if (
    !store ||
    !state.claudeUsage ||
    !state.codexUsage ||
    !state.openCodeUsage ||
    !state.museUsage
  ) {
    throw new Error('Usage stores must be initialized before account services')
  }
  state.codexSessionMigration = createCodexSessionMigrationScheduler({
    isEligible: () =>
      state.codexRuntimeHome?.isHostSystemDefaultSessionMigrationEligible() === true,
    isQuitting: () => state.isQuitting,
    resolveSystemCodexHomePathOverride: () =>
      resolveHostCodexSessionSourceHome(store.getSettings()),
    prepareScheduledRun: (scanDates) =>
      state.codexRuntimeHome?.prepareHostSystemDefaultSessionMigrationPass(scanDates),
    finishScheduledRun: () => state.codexRuntimeHome?.finishHostSystemDefaultSessionMigrationPass(),
    startBackfill: startCodexSessionBackfillInBackground,
    startIndexHeal: startCodexSessionIndexHealInBackground
  })
  const services = createProviderAccountServices(store, {
    sessionMover: {
      headless: false,
      getController: () => state.runtime?.ptyController ?? null,
      onNotice: (notice) => {
        dispatchClaudeRecentMoves(
          state.runtime?.dispatchMobileNotification,
          notice,
          translateMain('accounts.claude.sessionMover.recentMoves', 'Recent moves')
        )
        if (notice.kind === 'skipped' || !store.getSettings().notifications.enabled) {
          return
        }
        const body =
          notice.kind === 'moved'
            ? notice.balance
              ? translateMain(
                  'accounts.claude.sessionMover.rebalanceBody',
                  '{{from}} continues on {{to}} to balance your accounts.',
                  { from: notice.from.email, to: notice.to?.email ?? '' }
                )
              : notice.restartless
                ? translateMain(
                    'accounts.claude.sessionMover.movedRestartlessBody',
                    '{{from}} is near its usage limit. The session continues on {{to}} without a restart.',
                    { from: notice.from.email, to: notice.to?.email ?? '' }
                  )
                : translateMain(
                    'accounts.claude.sessionMover.movedBody',
                    '{{from}} is near its usage limit. The session continues on {{to}}.',
                    { from: notice.from.email, to: notice.to?.email ?? '' }
                  )
            : notice.kind === 'ask'
              ? translateMain(
                  'accounts.claude.sessionMover.askBody',
                  'A session on {{from}} is near its usage limit. Set "Move running sessions before a usage limit" to Move to move it automatically.',
                  { from: notice.from.email }
                )
              : translateMain(
                  'accounts.claude.sessionMover.failedBody',
                  'A session on {{from}} could not be moved: {{detail}}',
                  { from: notice.from.email, detail: notice.detail }
                )
        getRuntimeDesktopSurface().showNotification({
          title: translateMain('accounts.claude.sessionMover.noticeTitle', 'Claude session mover'),
          body
        })
      }
    },
    codexAccountLifecycle: { onHostSystemDefaultSelected: state.codexSessionMigration.requestRun },
    setClaudeStatusLineListener: (listener) =>
      agentHookServer.setClaudeStatusLineListener(listener),
    onClaudeAutoSwitched: ({ from, to, target, ...accountSnapshot }) => {
      const switched: ClaudeAutoSwitchedEvent = {
        ...accountSnapshot,
        fromAccountId: from.id,
        toAccountId: to.id,
        target
      }
      state.mainWindow?.webContents.send('claudeAccounts:autoSwitched', switched)
      if (!store.getSettings().notifications.enabled) {
        return
      }
      getRuntimeDesktopSurface().showNotification({
        title: translateMain('accounts.claude.autoSwitchedTitle', 'Claude account switched'),
        body: translateMain(
          'accounts.claude.autoSwitchedBody',
          '{{from}} is near its usage limit. New Claude sessions start on {{to}}.',
          { from: from.email, to: to.email }
        )
      })
    }
  })
  void startClaudeAuthProxy()
  const paneAssignedEvent = (notice: ClaudePaneAssignedNotice): ClaudePaneAssignedEvent => {
    const accounts = store.getSettings().claudeManagedAccounts
    const emails = accounts.map((account) => account.email)
    const account = notice.accountId
      ? accounts.find((candidate) => candidate.id === notice.accountId)
      : undefined
    const email = account?.email ?? ''
    return {
      ptyId: notice.ptyId,
      paneKey: notice.paneKey,
      accountId: notice.accountId,
      email,
      label:
        notice.accountId === null
          ? ''
          : email
            ? claudeAccountShortLabel(email, emails)
            : notice.accountId.slice(0, 8)
    }
  }
  const stopPaneAssigned = onClaudePaneAssigned((notice) => {
    state.mainWindow?.webContents.send('claudeAccounts:paneAssigned', paneAssignedEvent(notice))
  })
  state.stopClaudeSessionMover = () => {
    stopPaneAssigned()
    services.sessionMover?.stop()
  }
  state.rateLimits = services.rateLimits
  state.codexRuntimeHome = services.codexRuntimeHome
  state.codexAccounts = services.codexAccounts
  state.claudeRuntimeAuth = services.claudeRuntimeAuth
  state.claudeAccounts = services.claudeAccounts
  void startCodexStateDbBackfillRecoveryInBackground(getOrcaManagedCodexHomePath())
  // Defer shared-home migration; compatibility launches re-arm non-destructive scans for new rollouts (#4444, #8612, #12480).
  state.codexSessionMigration.scheduleInitialRun()
  store.onSettingsChanged((updates) => {
    // An account switch would otherwise leave the next chat's picker on a cold catalog.
    if (MODEL_CATALOG_ACCOUNT_SETTINGS.some((key) => key in updates)) {
      prewarmStructuredAgentModelCatalogs()
    }
  })
  store.migrateLegacyOpenCodeGoApiKey({
    has: hasOpenCodeGoApiKey,
    read: readOpenCodeGoApiKey,
    save: saveOpenCodeGoApiKey
  })
  state.keybindings = new KeybindingService({
    homePath: app.getPath('home'),
    getLegacyOverrides: () => store.getSettings().keybindings,
    legacyTabSwitchSeed: {
      isPending: () => store.getSettings().tabSwitchKeybindingSeed === 'pending',
      markSeeded: () => store.updateSettings({ tabSwitchKeybindingSeed: 'done' })
    }
  })
  browserManager.setSettingsResolver(() => ({ keybindings: state.keybindings?.getOverrides() }))
}
