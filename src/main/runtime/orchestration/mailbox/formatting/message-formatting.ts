import { z } from 'zod'
import type { MessageRow } from '../../db/orchestration-records'
import { readAnswerSenderSnapshot } from '../../../../../shared/agent-session/journal/answer-sender-snapshot'
import {
  pairedLabelComputer,
  pairedSenderName,
  savedPairedSender
} from '../../../../../shared/orchestration/mailbox/paired-sender-name'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../shared/orchestration/orchestration-rpc-contract'
import type { OrchestrationCliCommand } from '../../workers/launch/orchestration-cli-command'
import type { OrchestrationMailContent } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import {
  formatReportFollowUpLine,
  type ReportFollowUpAction
} from '../../../../../shared/orchestration/mailbox/orchestration-report-follow-up'
import {
  formatBotItemReportHint,
  type BotItemReportFact
} from '../../../../../shared/bots/bot-item-report-hint'

// The fields of this host's own bot-request record that name a paired sender, in every shape it
// has saved them.
const RecordedPairedSender = z.object({
  fromBotName: z.string().nullish(),
  fromPairedComputer: z.string().optional(),
  fromPairedServer: z.string().optional(),
  fromComputer: z.string().nullish()
})

/** A bot request from a paired computer is named as its record names it, so the header says what
 *  the request does: a server it was pulled from by this computer's name for it, never the name the
 *  sender gave. */
function recordedPairedSender(
  msg: MessageRow,
  peerMail: MessageFormattingOptions['peerMail']
): string | null {
  const row = peerMail?.getBotRequest(msg.id)
  if (!row) {
    return null
  }
  let record: unknown
  try {
    record = JSON.parse(row.record)
  } catch {
    return null
  }
  const parsed = RecordedPairedSender.safeParse(record)
  const paired = parsed.success ? savedPairedSender(parsed.data) : null
  return paired ? pairedSenderName(paired) : null
}

function pairedSenderOf(
  msg: MessageRow,
  peerMail: MessageFormattingOptions['peerMail']
): string | null {
  const recorded = recordedPairedSender(msg, peerMail)
  if (recorded) {
    return recorded
  }
  const computer = pairedLabelComputer(msg.from_handle)
  if (!computer || peerMail?.getPeerMailMessage(msg.id)?.sender_label !== msg.from_handle) {
    return null
  }
  const saved = readAnswerSenderSnapshot(msg.answer_sender_snapshot)
  const sender = saved?.party.address === msg.from_handle ? saved : undefined
  return pairedSenderName({
    computer: sender?.host ?? computer,
    botName: sender?.bot ? sender.name : null
  })
}

const BANNER_WIDTH = 60
const SEPARATOR = '─'.repeat(BANNER_WIDTH)

export type MessageFormattingAuthority =
  | 'current'
  | 'legacy_compatibility'
  | 'legacy_recovery_replay'
  | 'legacy_read_only'

export type MessageFormattingOptions = {
  authority?: MessageFormattingAuthority
  /** Recorded links distinguish peer mail from local messages with similar sender labels; a bot
   *  request's own record names a paired sender. */
  peerMail?: {
    getPeerMailMessage(id: string): { sender_label: string } | undefined
    getBotRequest(id: string): { record: string } | undefined
  }
  supportedActionHints?: readonly string[]
  /** The CLI name the recipient runs; a chat's reply line must name the one it has. */
  cliCommand?: OrchestrationCliCommand
  /** A finished task's report offers its follow-up instead of a reply its worker would never read. */
  followUp?: ReportFollowUpAction
  /** The open item a finished worker was started for, read when the report is shown. */
  reportItem?: BotItemReportFact
}

function resolveAuthority(
  msg: MessageRow,
  authority: MessageFormattingAuthority | undefined
): MessageFormattingAuthority {
  if (authority) {
    return authority
  }
  return msg.run_id === ORCHESTRATION_LEGACY_RUN_ID ||
    msg.delivery_contract === 'legacy_direct' ||
    msg.delivery_contract === 'audit_only'
    ? 'legacy_read_only'
    : 'current'
}

function appendLegacyGuidance(
  lines: string[],
  authority: MessageFormattingAuthority,
  supportedActionHints: readonly string[]
): void {
  if (authority === 'legacy_read_only') {
    lines.push('[Inspection only: reply and acknowledgment are unavailable.]')
    return
  }
  if (authority === 'legacy_compatibility') {
    lines.push('[Use only the supported legacy action shown below.]')
  } else if (authority === 'legacy_recovery_replay') {
    lines.push(
      '[This bounded recovery replay may already have been seen. Use only the action shown below.]'
    )
  }
  for (const hint of supportedActionHints) {
    lines.push(`[Supported action: ${hint}]`)
  }
}

export function formatMessageBanner(msg: MessageRow, options: MessageFormattingOptions): string
export function formatMessageBanner(msg: MessageRow): string
export function formatMessageBanner(
  msg: MessageRow,
  options: MessageFormattingOptions = {}
): string {
  return formatMessageBannerWithContent(msg, options).text
}

export function formatMessageBannerWithContent(
  msg: MessageRow,
  options: MessageFormattingOptions = {}
): { text: string; content: OrchestrationMailContent } {
  const priorityTag =
    msg.priority === 'urgent' ? ' [URGENT]' : msg.priority === 'high' ? ' [HIGH]' : ''
  const authority = resolveAuthority(msg, options.authority)
  const authorityTag =
    authority === 'legacy_compatibility'
      ? ' [LEGACY COMPATIBILITY]'
      : authority === 'legacy_recovery_replay'
        ? ' [LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]'
        : authority === 'legacy_read_only'
          ? ' [LEGACY READ-ONLY]'
          : ''
  const paired = pairedSenderOf(msg, options.peerMail)
  const from = paired ?? `${msg.from_handle.toUpperCase()} (${msg.from_handle})`

  const header = `──── From: ${from}${priorityTag}${authorityTag} (${msg.type}) ────`

  const lines: string[] = [header]
  const appendField = (value: string, prefix = '', suffix = ''): readonly [number, number] => {
    const start = lines.reduce((length, line) => length + line.length + 1, prefix.length)
    lines.push(prefix + value + suffix)
    return [start, start + value.length]
  }
  const subject = appendField(msg.subject, 'Subject: ')
  if (authority !== 'current') {
    appendLegacyGuidance(lines, authority, options.supportedActionHints ?? [])
  }

  const body = msg.body ? appendField(msg.body) : undefined
  const payload = msg.payload ? appendField(msg.payload, '[Payload: ', ']') : undefined

  if (authority === 'current' && options.followUp) {
    lines.push(`[${formatReportFollowUpLine(options.followUp, options.cliCommand ?? 'orca')}]`)
  } else if (authority === 'current') {
    const explicitFrom =
      msg.to_handle.startsWith('run:') || msg.to_handle.startsWith('dispatch:')
        ? ''
        : ` --from ${msg.to_handle}`
    lines.push(
      `[Reply: ${options.cliCommand ?? 'orca'} orchestration reply --id ${msg.id}${explicitFrom} --body "..."]`
    )
  }
  if (authority === 'current' && options.reportItem) {
    lines.push(`[${formatBotItemReportHint(options.reportItem, options.cliCommand ?? 'orca')}]`)
  }
  lines.push(SEPARATOR)

  return {
    text: lines.join('\n'),
    content: { subject, ...(body ? { body } : {}), ...(payload ? { payload } : {}) }
  }
}

// One wrapper marks the message block boundary while leaving each banner independently parseable.
export function formatMessagesForInjection(messages: MessageRow[]): string {
  if (messages.length === 0) {
    return ''
  }

  const banners = messages.map(formatMessageBanner).join('\n\n')
  return `\n--- Orchestration Messages (${messages.length}) ---\n${banners}\n---\n`
}

/** A Run mailbox's `check` must name its Run: a plain check reads only the terminal's newest Run. */
export function orchestrationCheckRunFlag(mailboxHandle: string | undefined): string {
  return mailboxHandle?.startsWith('run:') ? ` --run ${mailboxHandle.slice('run:'.length)}` : ''
}

export function formatMessagePointer(
  count: number,
  mailboxHandle?: string,
  cliCommand: OrchestrationCliCommand = 'orca',
  heldDeliveryId?: string,
  terminalHandle?: string,
  /** Named so a check that comes back empty is still traceable to the mail it was woken for. */
  messageIds?: readonly string[]
): string {
  const noun = `${count === 1 ? 'message' : 'messages'}${messageIds?.length ? ` (${messageIds.join(', ')})` : ''}`
  const runFlag = orchestrationCheckRunFlag(mailboxHandle)
  const checkCommand = `${cliCommand} orchestration check${runFlag}${terminalHandle ? ` --terminal ${terminalHandle}` : ''}`
  if (heldDeliveryId) {
    return `\nYou have ${count} new orchestration ${noun} after delivery ${heldDeliveryId}, which you have not acknowledged. If you no longer have it, run \`${checkCommand}\` to see it again; once it is handled, run \`${checkCommand} --ack ${heldDeliveryId}\`, then \`${checkCommand}\` for the new mail.\n`
  }
  return `\nYou have ${count} orchestration ${noun}. Run \`${checkCommand}\`.\n`
}
