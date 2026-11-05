import type { MessageRow } from './types'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../shared/orchestration-rpc-contract'
import type { OrchestrationCliCommand } from './cli-command'
import type { OrchestrationMailContent } from '../../../shared/agent-session/agent-session-message-source'

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
  /** The CLI name the recipient runs; a chat's reply line must name the one it has. */
  cliCommand?: OrchestrationCliCommand
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
  const senderName = msg.from_handle.toUpperCase()

  const header = `──── From: ${senderName} (${msg.from_handle})${priorityTag}${authorityTag} (${msg.type}) ────`

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

  if (authority === 'current') {
    const explicitFrom =
      msg.to_handle.startsWith('run:') || msg.to_handle.startsWith('dispatch:')
        ? ''
        : ` --from ${msg.to_handle}`
    lines.push(
      `[Reply: ${options.cliCommand ?? 'orca'} orchestration reply --id ${msg.id}${explicitFrom} --body "..."]`
    )
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

// Both formatMessagePointer shapes with whitespace removed, since a composer may wrap them anywhere.
const POINTER_CLI = '(orca|orca-dev|orca-ide)orchestrationcheck((?:--run\\w+)?)'
const MESSAGE_POINTER_TEXT = [
  new RegExp(String.raw`^Youhave\d+orchestrationmessages?\.Run\x60${POINTER_CLI}\x60\.$`),
  new RegExp(
    String.raw`^Youhave\d+neworchestrationmessages?afterdelivery(\w+),whichyouhavenotacknowledged\.Ifyounolongerhaveit,run\x60${POINTER_CLI}\x60toseeitagain;onceitishandled,run\x60\2orchestrationcheck\3--ack\1\x60,then\x60\2orchestrationcheck\3\x60forthenewmail\.$`
  )
]

/** Whether composer text is exactly a pointer Orca typed (see formatMessagePointer), not the user's draft. */
export function isMessagePointerText(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  return MESSAGE_POINTER_TEXT.some((pointer) => pointer.test(compact))
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
    return `\nYou have ${count} new orchestration ${noun} after delivery ${heldDeliveryId}, which you have not acknowledged. If you no longer have it, run \`${cliCommand} orchestration check${runFlag}\` to see it again; once it is handled, run \`${cliCommand} orchestration check${runFlag} --ack ${heldDeliveryId}\`, then \`${cliCommand} orchestration check${runFlag}\` for the new mail.\n`
  }
  return `\nYou have ${count} orchestration ${noun}. Run \`${cliCommand} orchestration check${runFlag}\`.\n`
}
