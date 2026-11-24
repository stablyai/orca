// Which Gmail and Calendar rules listen where, and the run event each new mail or coming meeting
// starts. Everything the sender or organizer wrote goes into the event's quoted fields.
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import {
  isGoogleTrigger,
  type AutomationGoogleTrigger
} from '../../shared/automation-google-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import type { Bot } from '../../shared/bot-types'
import { mailboxAddresses } from '../../shared/google/email-address-list'
import {
  botDefaultGoogleAccount,
  botGoogleAccess,
  botMayUseGoogleAccount
} from '../../shared/google/google-bot-accounts'
import type { UpcomingEvent } from './google-calendar-changes'
import type { GoogleDefaultAccount } from './google-credential-store'
import { senderAddress, type NewMail } from './google-gmail-changes'

type GmailRule = Extract<AutomationGoogleTrigger, { source: 'gmail' }>
type CalendarRule = Extract<AutomationGoogleTrigger, { source: 'calendar' }>

export type GoogleRuleTarget<Rule extends AutomationGoogleTrigger = AutomationGoogleTrigger> = {
  automationId: string
  botId: string
  account: string
  rule: Rule
}

export type GoogleRunEvent = { automationId: string; event: AutomationRunEvent }

/**
 * The enabled bot automations' Google rules on accounts connected here that the bot may use, for bots
 * whose owner turned Google on. A rule without an account listens on the bot's default, while connected.
 */
export function googleRuleTargets(
  automations: readonly Pick<Automation, 'id' | 'enabled' | 'bot' | 'on'>[],
  bots: readonly Pick<Bot, 'id' | 'google' | 'googleAccounts'>[],
  accounts: readonly string[],
  defaultAccount: string | null
): GoogleRuleTarget[] {
  const connected = new Set(accounts.map((email) => email.toLowerCase()))
  return automations.flatMap((automation) => {
    const botId = automation.bot?.botId
    const bot = bots.find((entry) => entry.id === botId)
    if (!automation.enabled || !botId || bot?.google !== true) {
      return []
    }
    const access = botGoogleAccess(bot)
    const fallback = botDefaultGoogleAccount(access, defaultAccount)
    return (automation.on ?? []).flatMap((rule) => {
      if (!isGoogleTrigger(rule)) {
        return []
      }
      const account = rule.account?.toLowerCase() ?? fallback
      return account && connected.has(account) && botMayUseGoogleAccount(access, account)
        ? [{ automationId: automation.id, botId, account, rule }]
        : []
    })
  })
}

/** Why rules without an account (on bots with Google on) can't listen now, or null while they can. */
export function accountlessRulesPausedBy(
  fallback: GoogleDefaultAccount,
  automations: readonly Pick<Automation, 'enabled' | 'bot' | 'on'>[],
  bots: readonly Pick<Bot, 'id' | 'google'>[]
): string | null {
  const waiting = automations.some(
    (automation) =>
      automation.enabled &&
      bots.some((bot) => bot.id === automation.bot?.botId && bot.google === true) &&
      (automation.on ?? []).some((rule) => isGoogleTrigger(rule) && !rule.account)
  )
  return waiting && 'unreadable' in fallback ? fallback.unreadable : null
}

export function isGmailTarget(target: GoogleRuleTarget): target is GoogleRuleTarget<GmailRule> {
  return target.rule.source === 'gmail'
}

export function isCalendarTarget(
  target: GoogleRuleTarget
): target is GoogleRuleTarget<CalendarRule> {
  return target.rule.source === 'calendar'
}

// An entry with @ is one address; without, a domain and its subdomains.
function addressMatches(address: string, wanted: string): boolean {
  if (wanted.includes('@')) {
    return address === wanted
  }
  const domain = address.slice(address.lastIndexOf('@') + 1)
  return domain === wanted || domain.endsWith(`.${wanted}`)
}

export function gmailRuleMatches(
  rule: GmailRule,
  mail: NewMail,
  labelIds: ReadonlyMap<string, string> | null
): boolean {
  if (rule.from?.length) {
    const sender = senderAddress(mail.from)
    // A forged sender must never start a run, so a from= rule needs Gmail's domain check.
    if (!sender || !mail.senderVerified || !rule.from.some((w) => addressMatches(sender, w))) {
      return false
    }
  }
  if (rule.to?.length) {
    const recipients = mailboxAddresses(`${mail.to}, ${mail.cc}`)
    if (!recipients.some((address) => rule.to?.some((w) => addressMatches(address, w)))) {
      return false
    }
  }
  if (
    rule.subjectContains &&
    !mail.subject.toLowerCase().includes(rule.subjectContains.toLowerCase())
  ) {
    return false
  }
  if (rule.label) {
    const id = labelIds?.get(rule.label.toLowerCase()) ?? rule.label
    if (!mail.labelIds.includes(id)) {
      return false
    }
  }
  return true
}

export function gmailRunEvent(
  target: GoogleRuleTarget<GmailRule>,
  mail: NewMail
): AutomationRunEvent {
  return {
    triggerId: target.rule.id,
    source: 'gmail',
    event: 'new_email',
    key: `gmail:${target.account}:${mail.id}`,
    // Later mail in the thread folds into its unfinished run.
    subject: `gmail:${target.account}:thread:${mail.threadId}`,
    occurredAt: mail.at,
    ...(mail.from ? { actor: mail.from } : {}),
    place: `Gmail (${target.account})`,
    url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(target.account)}#all/${mail.threadId}`,
    text: [`Subject: ${mail.subject || '(no subject)'}`, mail.snippet].filter(Boolean).join('\n'),
    google: { account: target.account, ref: `gmail:thread:${mail.threadId}` }
  }
}

/** When a meeting's "minutes before" comes; the rule fires once at or after it, never after it starts. */
export const calendarDueAt = (rule: CalendarRule, event: UpcomingEvent) =>
  event.startMs - rule.minutesBefore * 60_000

export function calendarRunEvent(
  target: GoogleRuleTarget<CalendarRule>,
  event: UpcomingEvent
): AutomationRunEvent {
  const { summary } = event
  return {
    triggerId: target.rule.id,
    source: 'calendar',
    event: 'starting_soon',
    key: `${summary.ref}:${target.account}:${event.startMs}:${target.rule.minutesBefore}`,
    occurredAt: calendarDueAt(target.rule, event),
    ...(event.organizer ? { actor: event.organizer } : {}),
    place: `Google Calendar (${target.account})`,
    ...(event.htmlLink ? { url: event.htmlLink } : {}),
    text: [
      summary.title,
      `Starts ${new Date(event.startMs).toISOString()}`,
      ...(summary.location ? [`Where: ${summary.location}`] : []),
      ...(summary.meetUrl ? [`Meet: ${summary.meetUrl}`] : []),
      ...(summary.attendees.length > 0 ? [`${summary.attendees.length} invited`] : [])
    ].join('\n'),
    google: { account: target.account, ref: summary.ref }
  }
}
