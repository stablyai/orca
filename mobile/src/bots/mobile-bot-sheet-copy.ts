// The desktop bot panels' English wording, for the phone's bot header and sheet.
import { isHostNotConnectedError } from '../query/host-query-errors'
import type { AgentType } from '../../../src/shared/agent-status/contracts/agent-status-types'
import { formatAgentTypeLabel } from '../../../src/shared/agent-status/presentation/agent-type-label'
import { formatAutomationSchedule } from '../../../src/shared/automations/scheduling/automation-schedules'
import { botAutomationWhenParts } from '../../../src/shared/bots/bot-automation-when'
import { foldBotStatus, type BotRowStatus } from '../../../src/shared/bots/bot-row-status'
import { rollUpBotStatus } from '../../../src/shared/bots/bot-sidebar-workspaces'
import type { WorktreeStatus } from '../../../src/shared/worktree/row-display/worktree-status-rollup'
import { isConnectorSource } from '../../../src/shared/automation-event-triggers'
import { automationUnheardSources } from '../../../src/shared/bot-event-sources'
import { CONNECTOR_SOURCE_NAMES } from '../../../src/shared/connectors/external-conversation-link'
import { joinSentences } from '../../../src/shared/text/sentence-joining'
import { translate, type Translate } from '../i18n/mobile-i18n'
import type { AgentDotState } from '../worktree/agent-lineage/agent-row-display'
import type { BotAutomationView } from '../../../src/shared/bots/bot-activity-schema'

export function botAgentLabel(agent: AgentType): string {
  return agent === 'claude' ? 'Claude Code' : formatAgentTypeLabel(agent)
}

// The desktop's event words; an event a newer host sends falls back to its service's line.
const EVENT_LABELS: Partial<Record<string, Partial<Record<string, (t: Translate) => string>>>> = {
  slack: {
    mentioned: (t) => t('bots.events.slack.mentioned', 'When you’re mentioned in Slack'),
    message: (t) => t('bots.events.slack.message', 'On a Slack message'),
    reaction: (t) => t('bots.events.slack.reaction', 'On a Slack reaction')
  },
  github: {
    issue_opened: (t) => t('bots.events.github.issueOpened', 'When an issue is opened'),
    pr_opened: (t) => t('bots.events.github.prOpened', 'When a pull request is opened'),
    pr_pushed: (t) => t('bots.events.github.prPushed', 'On a push to a pull request'),
    pr_merged: (t) => t('bots.events.github.prMerged', 'When a pull request merges'),
    comment: (t) => t('bots.events.github.comment', 'On a GitHub comment'),
    review_comment: (t) => t('bots.events.github.reviewComment', 'On a review comment'),
    review: (t) => t('bots.events.github.review', 'On a pull request review'),
    mentioned: (t) => t('bots.events.github.mentioned', 'When mentioned on GitHub'),
    review_requested: (t) => t('bots.events.github.reviewRequested', 'When a review is requested'),
    assigned: (t) => t('bots.events.github.assigned', 'When assigned on GitHub'),
    ci_failed: (t) => t('bots.events.github.ciFailed', 'When CI fails'),
    ci_passed: (t) => t('bots.events.github.ciPassed', 'When CI passes'),
    pr_conflicted: (t) => t('bots.events.github.prConflicted', 'When a pull request has conflicts'),
    pr_closed: (t) => t('bots.events.github.prClosed', 'When a pull request is closed'),
    pr_ready: (t) => t('bots.events.github.prReady', 'When a pull request is ready for review'),
    labeled: (t) => t('bots.events.github.labeled', 'When a label is added'),
    issue_closed: (t) => t('bots.events.github.issueClosed', 'When an issue is closed'),
    deploy_finished: (t) => t('bots.events.github.deployFinished', 'When a deployment finishes'),
    security_alert: (t) => t('bots.events.github.securityAlert', 'On a security alert'),
    workflow_finished: (t) =>
      t('bots.events.github.workflowFinished', 'When a workflow run finishes')
  },
  linear: {
    assigned: (t) => t('bots.events.linear.assigned', 'When assigned in Linear'),
    mentioned: (t) => t('bots.events.linear.mentioned', 'When mentioned in Linear'),
    issue_created: (t) => t('bots.events.linear.issueCreated', 'When a Linear issue is created'),
    issue_moved: (t) => t('bots.events.linear.issueMoved', 'When a Linear issue moves')
  }
}

const SOURCE_EVENT_FALLBACKS: Partial<Record<string, (t: Translate) => string>> = {
  slack: (t) => t('bots.events.slackFallback', 'On a Slack event'),
  github: (t) => t('bots.events.githubFallback', 'On a GitHub event'),
  linear: (t) => t('bots.events.linearFallback', 'On a Linear event'),
  webhook: (t) => t('bots.events.webhookFallback', 'When its webhook is called')
}

export function botSkillsListedNote(agent: AgentType, botName: string, t: Translate): string {
  return joinSentences([
    t('bots.skills.listedTitle', '{{agent}} can’t load these skills directly.', {
      agent: botAgentLabel(agent)
    }),
    t(
      'bots.skills.listedBody',
      '{{bot}} gets a list of them in its instructions and reads one when it fits. They won’t appear in its / menu.',
      { bot: botName }
    )
  ])
}

export function eventLabel(trigger: { source: string; event?: string }, t: Translate): string {
  const known = trigger.event ? EVENT_LABELS[trigger.source]?.[trigger.event] : undefined
  return (
    (known ?? SOURCE_EVENT_FALLBACKS[trigger.source])?.(t) ??
    t('bots.events.anyFallback', 'On an event')
  )
}

/** When an automation runs, in words, with "Paused" when it is off. */
export function automationWhenText(
  automation: BotAutomationView,
  enabled: boolean,
  t: Translate
): string {
  const when = botAutomationWhenParts(automation)
    .map((part) =>
      part.kind === 'schedule'
        ? formatAutomationSchedule(automation.rrule)
        : eventLabel(part.trigger, t)
    )
    .join(' · ')
  return enabled ? when : [when, t('bots.automations.paused', 'Paused')].filter(Boolean).join(' · ')
}

function dotsStatus(dots: readonly AgentDotState[]): WorktreeStatus {
  return dots.some((dot) => dot === 'blocked' || dot === 'waiting' || dot === 'permission')
    ? 'permission'
    : dots.some((dot) => dot === 'working')
      ? 'working'
      : dots.some((dot) => dot === 'monitoring')
        ? 'monitoring'
        : 'active'
}

/** The list row's roll-up for a route the host list hasn't drawn: the home's chats, then its workers. */
export function botStatusFromDots(
  homeDots: readonly AgentDotState[],
  workerDots: readonly AgentDotState[],
  paused: boolean
): BotRowStatus {
  return foldBotStatus(
    rollUpBotStatus(
      dotsStatus(homeDots),
      workerDots.map((dot) => dotsStatus([dot]))
    ),
    paused
  )
}

/** The desktop's note on an automation whose events its bot has no connector for. */
export function automationWontFireNote(
  automation: BotAutomationView,
  bot: Parameters<typeof automationUnheardSources>[1][number],
  t: Translate,
  intlLocale: string
): string | null {
  const unheard = automationUnheardSources(automation, [bot])
  if (!unheard) {
    return null
  }
  const connectors = new Intl.ListFormat(intlLocale, { type: 'disjunction' }).format(
    unheard.sources.map((source) =>
      isConnectorSource(source)
        ? CONNECTOR_SOURCE_NAMES[source]
        : source === 'webhook'
          ? 'webhook'
          : 'Google'
    )
  )
  return unheard.scheduled
    ? t(
        'automations.eventsWontFire',
        'Runs on its schedule only: needs the {{connectors}} connector',
        { connectors }
      )
    : t('automations.wontFire', 'Won’t run: needs the {{connectors}} connector', {
        connectors
      })
}

/** Why a Settings save failed, in the owner's words. */
export function botSaveErrorMessage(error: unknown, hostName: string): string {
  return isHostNotConnectedError(error)
    ? translate('bots.items.write.offline', '{{host}} is offline.', { host: hostName })
    : error instanceof Error && error.message === 'bot_name_taken'
      ? translate('bots.settings.nameTaken', 'Another bot already has that name.')
      : error instanceof Error && error.message === 'bot_avatar_invalid'
        ? translate(
            'bots.picture.invalid',
            'That picture could not be used. Pick a PNG or JPG image.'
          )
        : error instanceof Error
          ? error.message
          : translate('bots.saveFailed', 'Couldn’t save')
}
