// The desktop's words for a hook (webhook-copy.ts, webhook-call-copy.ts, webhook-filter-text.tsx), under the phone's keys.
import { botResultsPlace } from '../../../../src/shared/automation-bot-target'
import type { AutomationBotResultsTo } from '../../../../src/shared/automation-bot-target'
import {
  webhookAdapterGeneratesSecret,
  webhookAdapterName
} from '../../../../src/shared/bots/webhook-card-view'
import type {
  WebhookAdapterId,
  WebhookFilters,
  WebhookWhere
} from '../../../../src/shared/connector-webhook-contract'
import { WEBHOOK_ERROR_CODES } from '../../../../src/shared/rpc-contract/webhooks-params'
import type { Translate } from '../../i18n/mobile-i18n'
import { getUiIntlLocale } from '../../i18n/ui-intl-locale'
import { commentRelativeTime } from '../../source-control/review/pull-request/comments/pr-comment-relative-time'
import type { PhoneWebhook, PhoneWebhookCall } from './mobile-webhook-operations'

export type WebhookErrorCode = (typeof WEBHOOK_ERROR_CODES)[number] | 'failed'

/** A refused webhooks.* reply in the host's codes, or null when no reply came back. A host without
 *  the methods needs an update. */
export function webhookReplyErrorCode(code: string | null): WebhookErrorCode {
  if (code === 'method_not_found') {
    return 'host_needs_update'
  }
  return WEBHOOK_ERROR_CODES.find((known) => known === code) ?? 'failed'
}

/** "5m ago", in the words the chat card uses for its last call. */
export function webhookAgo(at: number, now: number, t: Translate): string {
  return commentRelativeTime(new Date(at).toISOString(), now, t)
}

export function webhookResultsTo(resultsTo: AutomationBotResultsTo, t: Translate): string {
  if (resultsTo === 'chat') {
    return t('bots.webhooks.resultsToChat', 'results to Chat')
  }
  if (resultsTo === 'thread') {
    return t('bots.webhooks.resultsToThread', "results to the event's thread")
  }
  if (resultsTo === 'none') {
    return t('bots.webhooks.resultsNowhere', 'results not sent')
  }
  return t('bots.webhooks.resultsToPlace', 'results to {{place}}', {
    place: botResultsPlace(resultsTo)
  })
}

export function webhookStarts(hook: PhoneWebhook, t: Translate): string {
  return `“${hook.automationName}” · ${webhookResultsTo(hook.resultsTo, t)}`
}

export function webhookChecks(adapter: WebhookAdapterId | null, t: Translate): string {
  if (!adapter) {
    return t('bots.webhooks.checks.key', 'The key in the URL or header')
  }
  const sender = { sender: webhookAdapterName(adapter) }
  return webhookAdapterGeneratesSecret(adapter)
    ? t('bots.webhooks.checks.generated', '{{sender}} signature, with its signing secret', sender)
    : t('bots.webhooks.checks.pasted', '{{sender}} signature, with your {{sender}} secret', sender)
}

function whereWords(where: WebhookWhere, t: Translate): string {
  const values = new Intl.ListFormat(getUiIntlLocale(), { type: 'disjunction' }).format(
    where.values ?? []
  )
  switch (where.op) {
    case '=':
    case 'in':
      return t('bots.webhooks.where.is', 'is {{values}}', { values })
    case '!=':
      return t('bots.webhooks.where.isNot', 'isn’t {{values}}', { values })
    case 'contains':
      return t('bots.webhooks.where.contains', 'contains {{values}}', { values })
    case 'exists':
      return t('bots.webhooks.where.exists', 'is present')
    case '!exists':
      return t('bots.webhooks.where.missing', 'is missing')
  }
}

/** "level is error or fatal, and project is web", or "Every call". */
export function webhookOnlyWhen(filters: WebhookFilters, t: Translate): string {
  const clauses = (filters.where ?? []).map((where) => `${where.path} ${whereWords(where, t)}`)
  if (filters.textContains) {
    clauses.push(
      t('bots.webhooks.where.text', 'the body contains “{{text}}”', { text: filters.textContains })
    )
  }
  if (filters.subject) {
    clauses.push(
      t('bots.webhooks.where.subject', 'it’s about {{subject}}', { subject: filters.subject })
    )
  }
  return clauses.length > 0
    ? clauses.join(t('bots.webhooks.where.and', ', and '))
    : t('bots.webhooks.everyCall', 'Every call')
}

/** The plain line for a host that can't act on its hooks now. */
export function webhookHostLine(
  host: PhoneWebhook['host'] | WebhookErrorCode,
  botName: string,
  t: Translate
): string | null {
  if (host === 'offline' || host === 'host_offline') {
    return t('bots.webhooks.hostOffline', '{{bot}}’s computer is offline', { bot: botName })
  }
  if (host === 'host_needs_update') {
    return t(
      'bots.webhooks.hostNeedsUpdate',
      'Your Orca needs an update before {{bot}} can do this.',
      { bot: botName }
    )
  }
  return null
}

export function webhookErrorMessage(code: WebhookErrorCode, botName: string, t: Translate): string {
  switch (code) {
    case 'webhook_not_found':
      return t('bots.webhooks.errors.notFound', 'This webhook was deleted.')
    case 'webhooks_unavailable':
      return t('bots.webhooks.errors.unavailable', 'Webhooks aren’t available right now.')
    case 'host_offline':
    case 'host_needs_update':
      return webhookHostLine(code, botName, t) ?? ''
    case 'failed':
      return t('bots.errors.generic', 'Something went wrong. Try again.')
  }
}

function runLine(
  runNumber: number | undefined,
  resultsTo: AutomationBotResultsTo,
  t: Translate
): string | null {
  if (runNumber === undefined) {
    return null
  }
  if (resultsTo === 'none' || resultsTo === 'thread') {
    return t('bots.webhooks.calls.run', 'run #{{number}}', { number: runNumber })
  }
  const place =
    resultsTo === 'chat' ? t('bots.webhooks.calls.chat', 'Chat') : botResultsPlace(resultsTo)
  return t('bots.webhooks.calls.runIn', 'run #{{number}} in {{place}}', {
    number: runNumber,
    place
  })
}

/** One Recent calls line: what happened, then why. */
export function webhookCallLine(
  row: PhoneWebhookCall,
  botName: string,
  resultsTo: AutomationBotResultsTo,
  t: Translate
): { label: string; detail: string } {
  if (row.kind !== 'call') {
    const count = { count: row.count }
    switch (row.kind) {
      case 'refused':
        return {
          label: t('bots.webhooks.calls.refused', 'Refused ×{{count}}', count),
          detail: t('bots.webhooks.calls.refusedDetail', 'wrong key or signature · nothing kept')
        }
      case 'over_budget':
        return {
          label: t('bots.webhooks.calls.overBudget', 'Over budget ×{{count}}', count),
          detail: t('bots.webhooks.calls.overBudgetDetail', 'too many calls · nothing kept')
        }
      case 'duplicate':
        return {
          label: t('bots.webhooks.calls.duplicate', 'Duplicate ×{{count}}', count),
          detail: t('bots.webhooks.calls.duplicateDetail', 'already received')
        }
    }
  }
  const sample = row.sample ? t('bots.webhooks.calls.sample', 'sample') : null
  const join = (...parts: (string | null | undefined)[]): string =>
    parts.filter((part): part is string => Boolean(part)).join(' · ')
  const bot = { bot: botName }
  switch (row.state) {
    case 'queued':
      return {
        label: t('bots.webhooks.calls.queued', 'Queued'),
        detail: join(
          t('bots.webhooks.calls.queuedDetail', 'waiting for {{bot}}’s computer', bot),
          sample
        )
      }
    case 'delivered':
      return {
        label: t('bots.webhooks.calls.delivered', 'Delivered'),
        detail: join(t('bots.webhooks.calls.deliveredDetail', 'on {{bot}}’s computer', bot), sample)
      }
    case 'ignored':
      return {
        label: t('bots.webhooks.calls.ignored', 'Ignored'),
        detail: join(t('bots.webhooks.calls.ignoredDetail', 'didn’t match Only when'), sample)
      }
    case 'paused':
      return {
        label: t('bots.webhooks.calls.paused', 'Paused'),
        detail: join(t('bots.webhooks.calls.pausedDetail', 'nothing started'), sample)
      }
    case 'cancelled':
      return {
        label: t('bots.webhooks.calls.cancelled', 'Cancelled'),
        detail: join(
          t('bots.webhooks.calls.cancelledDetail', 'paused, rotated or deleted first'),
          sample
        )
      }
    case 'waiting_capacity':
      return {
        label: t('bots.webhooks.calls.waiting', 'Waiting'),
        detail: join(t('bots.webhooks.calls.waitingDetail', 'for the hourly run limit'), sample)
      }
    case 'started':
      return {
        label: t('bots.webhooks.calls.started', 'Started'),
        detail: join(runLine(row.runNumber, resultsTo, t), sample)
      }
    case 'folded':
      return {
        label: t('bots.webhooks.calls.folded', 'Folded'),
        detail: join(t('bots.webhooks.calls.foldedDetail', 'counted, not shown to the run'), sample)
      }
    case 'refused':
      return {
        label: t('bots.webhooks.calls.refusedOne', 'Refused'),
        detail: join(row.reason, sample)
      }
    case 'missed':
      return {
        label: t('bots.webhooks.calls.missed', 'Skipped'),
        detail: join(
          t('bots.webhooks.calls.missedDetail', 'past the automation’s missed-run grace'),
          sample
        )
      }
    case 'unavailable':
      return {
        label: t('bots.webhooks.calls.unavailable', 'Unavailable'),
        detail: join(row.reason, sample)
      }
    case 'completed':
      return { label: t('bots.webhooks.calls.completed', 'Done'), detail: join(sample) }
    case 'failed':
      return { label: t('bots.webhooks.calls.failed', 'Failed'), detail: join(row.reason, sample) }
    case 'unverifiable':
      return {
        label: t('bots.webhooks.calls.unverifiable', 'Unverifiable'),
        detail: join(
          t('bots.webhooks.calls.unverifiableDetail', '{{bot}}’s computer can’t be reached', bot),
          sample
        )
      }
  }
}
