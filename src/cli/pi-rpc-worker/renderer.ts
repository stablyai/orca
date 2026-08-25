import type { LifecycleAction } from './lifecycle'
import type { RpcObject } from './types'

export const PI_WORKING_TITLE = '\u001b]0;⠋ π - Orca worker\u0007'
export const PI_IDLE_TITLE = '\u001b]0;π - Orca worker\u0007'

function stripTerminalControls(value: string): string {
  const output: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x1b) {
      const kind = value.charCodeAt(index + 1)
      if (kind === 0x5d) {
        index += 2
        while (index < value.length && value.charCodeAt(index) !== 0x07) {
          if (value.charCodeAt(index) === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
            index += 1
            break
          }
          index += 1
        }
        continue
      }
      if (kind === 0x5b) {
        index += 2
        while (index < value.length) {
          const current = value.charCodeAt(index)
          if (current >= 0x40 && current <= 0x7e) {
            break
          }
          index += 1
        }
        continue
      }
      continue
    }
    const disallowedControl =
      (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
    const bidiControl = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
    if (!disallowedControl && !bidiControl) {
      output.push(value[index])
    }
  }
  return output.join('')
}

function redactExact(value: string, secrets: readonly string[]): string {
  let redacted = value
  for (const secret of secrets) {
    if (secret.length >= 3 && redacted.includes(secret)) {
      redacted = redacted.split(secret).join('[redacted]')
    }
  }
  return redacted
}

function looksLikeRawJson(value: string): boolean {
  const trimmed = value.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return false
  }
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

export function sanitizeForTerminal(
  value: unknown,
  secrets: readonly string[] = [],
  maxChars = 8_192
): string {
  if (typeof value !== 'string') {
    return ''
  }
  let sanitized = stripTerminalControls(value)
  sanitized = redactExact(sanitized, secrets)
  if (looksLikeRawJson(sanitized)) {
    return '[structured output omitted]'
  }
  if (sanitized.length > maxChars) {
    return `${sanitized.slice(0, maxChars)}…`
  }
  return sanitized
}

function safeToolName(value: unknown): string {
  const name = sanitizeForTerminal(value, [], 128)
  return /^[A-Za-z0-9_-]+$/u.test(name) ? name : 'tool'
}

export type RenderedPiEvent = {
  output?: string
  title?: string
}

export function renderPiEvent(event: RpcObject, secrets: readonly string[]): RenderedPiEvent {
  if (event.type === 'agent_start') {
    return { title: PI_WORKING_TITLE }
  }
  if (event.type === 'agent_settled') {
    return { title: PI_IDLE_TITLE }
  }
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent
    if (
      typeof update === 'object' &&
      update !== null &&
      (update as { type?: unknown }).type === 'text_delta'
    ) {
      const output = sanitizeForTerminal((update as { delta?: unknown }).delta, secrets)
      return output ? { output } : {}
    }
    return {}
  }
  if (event.type === 'tool_execution_start') {
    const name = safeToolName(event.toolName)
    const label = name.startsWith('orca_') ? 'Orca lifecycle' : name
    return { output: `\n[tool] ${label}\n` }
  }
  if (event.type === 'tool_execution_end' && event.isError === true) {
    return { output: `[tool] ${safeToolName(event.toolName)} failed\n` }
  }
  return {}
}

export function renderLifecycleAction(
  action: LifecycleAction,
  secrets: readonly string[]
): string | undefined {
  if (action.type === 'progress') {
    const phase = sanitizeForTerminal(action.input.phase, secrets, 64)
    const message = sanitizeForTerminal(action.input.message, secrets, 2_048)
    return `\n[${phase || 'progress'}] ${message}\n`
  }
  if (action.type === 'escalation') {
    return '\n[Orca] Blocker escalated to the coordinator.\n'
  }
  if (action.type === 'ask') {
    return '\n[Orca] Waiting for the coordinator…\n'
  }
  if (action.type === 'done') {
    return '\n[Orca] Completion recorded; waiting for clean shutdown…\n'
  }
  return undefined
}
