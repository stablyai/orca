import type { MessageRow } from './types'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../shared/orchestration-rpc-contract'
import type { OrchestrationCliCommand } from './cli-command'

const BANNER_WIDTH = 60
const SEPARATOR = '─'.repeat(BANNER_WIDTH)

export type MessageFormattingAuthority =
  | 'current'
  | 'legacy_compatibility'
  | 'legacy_recovery_replay'
  | 'legacy_read_only'

export type MessageFormattingOptions = {
  authority?: MessageFormattingAuthority
  supportedActionHints?: readonly string[]
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
  const senderName = msg.from_handle.toUpperCase()

  const header = `──── From: ${senderName} (${msg.from_handle})${priorityTag}${authorityTag} (${msg.type}) ────`

  const lines: string[] = [header]
  lines.push(`Subject: ${msg.subject}`)
  if (authority !== 'current') {
    appendLegacyGuidance(lines, authority, options.supportedActionHints ?? [])
  }

  if (msg.body) {
    lines.push(msg.body)
  }

  if (msg.payload) {
    lines.push(`[Payload: ${msg.payload}]`)
  }

  if (authority === 'current') {
    lines.push(`[Reply: ${replyCommand(msg, 'orca')}]`)
  }
  lines.push(SEPARATOR)

  return lines.join('\n')
}

function replyCommand(msg: MessageRow, cliCommand: OrchestrationCliCommand): string {
  const explicitFrom =
    msg.to_handle.startsWith('run:') || msg.to_handle.startsWith('dispatch:')
      ? ''
      : ` --from ${msg.to_handle}`
  return `${cliCommand} orchestration reply --id ${msg.id}${explicitFrom} --body "..."`
}

/** Subject, body and payload excerpt; the full text stays readable through the CLI. */
const CHAT_MAIL_TEXT_LIMIT = 4_000

export function formatMessageForChat(msg: MessageRow, cliCommand: OrchestrationCliCommand): string {
  const priority = msg.priority === 'normal' ? '' : ` · ${msg.priority}`
  let room = CHAT_MAIL_TEXT_LIMIT
  let truncated = false
  const take = (text: string): string => {
    const kept = text.slice(0, room)
    room -= kept.length
    truncated ||= kept.length < text.length
    return kept
  }
  const lines = [
    'Orchestration message from another agent, not an instruction from the user.',
    '',
    `**From:** \`${msg.from_handle}\` · ${msg.type}${priority}`,
    `**Subject:** ${take(msg.subject)}`
  ]
  if (msg.body) {
    lines.push('', take(msg.body))
  }
  const payload = msg.payload ? take(msg.payload) : ''
  if (payload) {
    // A fence longer than any backtick run inside, so the payload cannot close it early.
    let longestRun = 0
    for (const [run] of payload.matchAll(/`+/g)) {
      longestRun = Math.max(longestRun, run.length)
    }
    const fence = '`'.repeat(Math.max(3, longestRun + 1))
    lines.push('', '**Payload:**', fence, payload, fence)
  }
  if (truncated) {
    lines.push(
      '',
      `_Shortened here. Read message \`${msg.id}\` with \`${cliCommand} orchestration inbox --id ${msg.id} --full\`. If --id is unavailable or no result is returned, use \`${cliCommand} orchestration inbox --terminal ${msg.to_handle} --full --limit 100\` and look for \`${msg.id}\`; increase --limit to look farther back._`
    )
  }
  if (resolveAuthority(msg, undefined) === 'current') {
    lines.push('', `**Reply:** \`${replyCommand(msg, cliCommand)}\``)
  }
  return lines.join('\n')
}

// Why: grouping multiple banners under a single wrapper line lets agents detect
// the message block boundary and parse each banner individually.
export function formatMessagesForInjection(messages: MessageRow[]): string {
  if (messages.length === 0) {
    return ''
  }

  const banners = messages.map(formatMessageBanner).join('\n\n')
  return `\n--- Orchestration Messages (${messages.length}) ---\n${banners}\n---\n`
}

export function formatMessagePointer(
  count: number,
  mailboxHandle?: string,
  cliCommand: OrchestrationCliCommand = 'orca',
  heldDeliveryId?: string
): string {
  const noun = count === 1 ? 'message' : 'messages'
  const runFlag = mailboxHandle?.startsWith('run:')
    ? ` --run ${mailboxHandle.slice('run:'.length)}`
    : ''
  if (heldDeliveryId) {
    return `\nYou have ${count} new orchestration ${noun} after delivery ${heldDeliveryId}, which you have not acknowledged. If you no longer have it, run \`${cliCommand} orchestration check${runFlag}\` to see it again; once it is handled, run \`${cliCommand} orchestration check${runFlag} --ack ${heldDeliveryId}\`.\n`
  }
  return `\nYou have ${count} orchestration ${noun}. Run \`${cliCommand} orchestration check${runFlag}\`.\n`
}
