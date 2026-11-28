import {
  AUTOMATION_RUN_FAILURE_COPY as EN,
  type AutomationRunFailureCode
} from '../../../src/shared/automations/history/automation-run-failure-copy'
import type { Translate } from '../i18n/mobile-i18n'
import type { MobileAutomationRun } from './automation-reply-schema'

export function automationRunStatusLabel(status: string, t: Translate): string {
  const runStatusLabels: Record<string, string> = {
    pending: t('automations.mobile.pending', 'Pending'),
    dispatching: t('automations.mobile.starting', 'Starting'),
    dispatched: t('automations.mobile.dispatched', 'Dispatched'),
    completed: t('automations.mobile.completed', 'Completed'),
    skipped_precheck: t('automations.mobile.skippedPrecheck', 'Skipped · precheck'),
    skipped_missed: t('automations.mobile.skippedMissedSchedule', 'Skipped · missed schedule'),
    skipped_unavailable: t(
      'automations.mobile.skippedHostUnavailable',
      'Skipped · host unavailable'
    ),
    skipped_needs_interactive_auth: t(
      'automations.mobile.skippedSignInNeeded',
      'Skipped · sign-in needed'
    ),
    dispatch_failed: t('automations.mobile.couldNotStart', 'Could not start')
  }
  return runStatusLabels[status] ?? t('automations.mobile.unknownResult', 'Unknown result')
}
export function automationDate(
  timestamp: number | null | undefined,
  t: Translate,
  locale: string,
  timezone?: string
): string {
  if (timestamp == null) {
    return t('automations.mobile.notReported', 'Not reported')
  }
  try {
    return new Date(timestamp).toLocaleString(locale, {
      ...(timezone ? { timeZone: timezone } : {}),
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  } catch {
    return new Date(timestamp).toLocaleString(locale)
  }
}
export function runMatchesOutcome(run: MobileAutomationRun, outcome: string): boolean {
  if (outcome === 'all') {
    return true
  }
  if (outcome === 'skipped') {
    return run.status.startsWith('skipped_')
  }
  if (outcome === 'active') {
    return ['pending', 'dispatching', 'dispatched'].includes(run.status)
  }
  return run.status === outcome
}

// One whole sentence per non-ready setup state; unknown states keep the stored English.
const SETUP_STATE_COPY: Record<string, (t: Translate) => string> = {
  'not-set-up': (t) =>
    t(
      'automations.runFailures.projectSetupState.notSetUp',
      'The project is not set up on the selected automation host.'
    ),
  'setting-up': (t) =>
    t(
      'automations.runFailures.projectSetupState.settingUp',
      'The project is still being set up on the selected automation host.'
    ),
  error: (t) =>
    t(
      'automations.runFailures.projectSetupState.error',
      'Project setup failed on the selected automation host.'
    ),
  unsupported: (t) =>
    t(
      'automations.runFailures.projectSetupState.unsupported',
      'The selected automation host does not support this project.'
    )
}

// null = unusable params; caller shows the stored English `error`.
const COPY: Record<
  AutomationRunFailureCode,
  (params: MobileAutomationRun['errorParams'], t: Translate) => string | null
> = {
  noDispatchHost: (_params, t) => t('automations.runFailures.noDispatchHost', EN.noDispatchHost),
  unevaluableSchedule: (_params, t) =>
    t('automations.runFailures.unevaluableSchedule', EN.unevaluableSchedule),
  noRunnableHost: (_params, t) => t('automations.runFailures.noRunnableHost', EN.noRunnableHost),
  wslMoveInProgress: (_params, t) =>
    t('automations.runFailures.wslMoveInProgress', EN.wslMoveInProgress),
  wslMoveOwnedByHost: (_params, t) =>
    t('automations.runFailures.wslMoveOwnedByHost', EN.wslMoveOwnedByHost),
  managedHostServer: (params, t) => {
    const host = params?.host
    return typeof host === 'string'
      ? t('automations.runFailures.managedHostServer', EN.managedHostServer, { host })
      : null
  },
  missedGraceWindow: (_params, t) =>
    t('automations.runFailures.missedGraceWindow', EN.missedGraceWindow),
  targetMissing: (_params, t) => t('automations.runFailures.targetMissing', EN.targetMissing),
  targetReplaced: (_params, t) => t('automations.runFailures.targetReplaced', EN.targetReplaced),
  workspaceHostAmbiguous: (_params, t) =>
    t('automations.runFailures.workspaceHostAmbiguous', EN.workspaceHostAmbiguous),
  legacyTwinHosts: (_params, t) => t('automations.runFailures.legacyTwinHosts', EN.legacyTwinHosts),
  targetUnavailable: (_params, t) =>
    t('automations.runFailures.targetUnavailable', EN.targetUnavailable),
  remoteSchedulingUnavailable: (_params, t) =>
    t('automations.runFailures.remoteSchedulingUnavailable', EN.remoteSchedulingUnavailable),
  projectSetupMissing: (_params, t) =>
    t('automations.runFailures.projectSetupMissing', EN.projectSetupMissing),
  projectSetupNotReady: (params, t) => {
    const state = params?.setupState
    return typeof state === 'string' && Object.hasOwn(SETUP_STATE_COPY, state)
      ? SETUP_STATE_COPY[state](t)
      : null
  },
  targetSetupMismatch: (_params, t) =>
    t('automations.runFailures.targetSetupMismatch', EN.targetSetupMismatch),
  repoUnavailable: (_params, t) => t('automations.runFailures.repoUnavailable', EN.repoUnavailable),
  repoDetached: (_params, t) => t('automations.runFailures.repoDetached', EN.repoDetached),
  projectPathChanged: (_params, t) =>
    t('automations.runFailures.projectPathChanged', EN.projectPathChanged),
  automationChanged: (_params, t) =>
    t('automations.runFailures.automationChanged', EN.automationChanged),
  destinationChanged: (_params, t) =>
    t('automations.runFailures.destinationChanged', EN.destinationChanged),
  hooksReviewBlocked: (_params, t) =>
    t('automations.runFailures.hooksReviewBlocked', EN.hooksReviewBlocked),
  agentNeverStarted: (_params, t) =>
    t('automations.runFailures.agentNeverStarted', EN.agentNeverStarted),
  agentNoCompletion: (_params, t) =>
    t('automations.runFailures.agentNoCompletion', EN.agentNoCompletion),
  agentInterrupted: (_params, t) =>
    t('automations.runFailures.agentInterrupted', EN.agentInterrupted),
  watchTimedOut: (_params, t) => t('automations.runFailures.watchTimedOut', EN.watchTimedOut),
  wslDistroStopped: (params, t) => {
    const distro = params?.distro
    return typeof distro === 'string'
      ? t('automations.runFailures.wslDistroStopped', EN.wslDistroStopped, { distro })
      : null
  },
  botsOff: (_params, t) => t('automations.runFailures.botsOff', EN.botsOff),
  botsOffByTeam: (_params, t) => t('automations.runFailures.botsOffByTeam', EN.botsOffByTeam),
  botMissing: (_params, t) => t('automations.runFailures.botMissing', EN.botMissing),
  botFolderMissing: (_params, t) =>
    t('automations.runFailures.botFolderMissing', EN.botFolderMissing),
  botPaused: (params, t) => {
    const bot = params?.bot
    return typeof bot === 'string'
      ? t('automations.runFailures.botPaused', EN.botPaused, { bot })
      : null
  }
}

function isAutomationRunFailureCode(code: unknown): code is AutomationRunFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

/** Old records and older hosts omit the code; newer hosts may send unknown codes. Both show `error`. */
export function automationRunErrorText(
  run: Pick<MobileAutomationRun, 'error' | 'errorCode' | 'errorParams'>,
  t: Translate
): string | null {
  if (run.error === null || !isAutomationRunFailureCode(run.errorCode)) {
    return run.error
  }
  return COPY[run.errorCode](run.errorParams, t) ?? run.error
}
