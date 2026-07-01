import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'

export const CODEWHALE_HOOK_EVENTS = [
  'tool_call_after',
  'turn_end',
  'on_error',
  'session_end'
] as const

export type CodeWhaleHookEvent = (typeof CODEWHALE_HOOK_EVENTS)[number]

const BLOCK_START = '# >>> orca-managed-codewhale-hooks (managed by Orca; do not edit) >>>'
const BLOCK_END = '# <<< orca-managed-codewhale-hooks <<<'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const MANAGED_BLOCK_RE = new RegExp(
  `\\n*${escapeRegExp(BLOCK_START)}[\\s\\S]*?(?:${escapeRegExp(BLOCK_END)}[^\\n]*|$)`,
  'g'
)

function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

function unescapeTomlBasicString(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function tomlBoolean(value: boolean): string {
  return value ? 'true' : 'false'
}

function readTomlStringField(tableText: string, key: string): string | undefined {
  const basic = tableText.match(
    new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm')
  )?.[1]
  if (basic !== undefined) {
    return unescapeTomlBasicString(basic)
  }
  return tableText.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*'([^']*)'`, 'm'))?.[1]
}

function nextTomlTableIndex(configText: string, startIndex: number): number {
  const tableHeader = /^\s*\[+[^#\]\r\n]+?\]+/gm
  tableHeader.lastIndex = startIndex
  return tableHeader.exec(configText)?.index ?? configText.length
}

function removeManagedCodeWhaleHookTables(
  configText: string,
  isManagedCommand: (command: string | undefined) => boolean
): string {
  const hookTable = /^\s*\[\[hooks\.hooks\]\]\s*(?:#.*)?$/gm
  let nextText = ''
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = hookTable.exec(configText)) !== null) {
    const tableStart = match.index
    const tableEnd = nextTomlTableIndex(configText, hookTable.lastIndex)
    const tableText = configText.slice(tableStart, tableEnd)
    nextText += configText.slice(cursor, tableStart)
    const command = readTomlStringField(tableText, 'command')
    if (!isManagedCommand(command)) {
      nextText += tableText
    }
    cursor = tableEnd
    hookTable.lastIndex = tableEnd
  }

  if (cursor === 0) {
    return configText
  }
  return nextText + configText.slice(cursor)
}

function stripManagedCodeWhaleHooks(
  configText: string,
  isManagedCommand?: (command: string | undefined) => boolean
): string {
  const withoutManagedBlock = configText.replace(MANAGED_BLOCK_RE, '')
  return isManagedCommand
    ? removeManagedCodeWhaleHookTables(withoutManagedBlock, isManagedCommand)
    : withoutManagedBlock
}

export function buildManagedCodeWhaleHooksBlock(
  commandForEvent: (event: CodeWhaleHookEvent) => string
): string {
  const entries = CODEWHALE_HOOK_EVENTS.map((event) =>
    [
      '[[hooks.hooks]]',
      `name = "orca-status-${event}"`,
      `event = ${tomlBasicString(event)}`,
      `command = ${tomlBasicString(commandForEvent(event))}`,
      `timeout_secs = ${MANAGED_HOOK_TIMEOUT_SECONDS}`,
      `background = ${tomlBoolean(event === 'session_end')}`,
      'continue_on_error = true'
    ].join('\n')
  )
  return [BLOCK_START, entries.join('\n\n'), BLOCK_END].join('\n')
}

export function applyManagedCodeWhaleHooks(
  configText: string,
  commandForEvent: (event: CodeWhaleHookEvent) => string,
  isManagedCommand?: (command: string | undefined) => boolean
): string {
  const withoutManaged = stripManagedCodeWhaleHooks(configText, isManagedCommand).replace(/\s+$/, '')
  const block = buildManagedCodeWhaleHooksBlock(commandForEvent)
  return withoutManaged.length > 0 ? `${withoutManaged}\n\n${block}\n` : `${block}\n`
}

export function removeManagedCodeWhaleHooks(configText: string): {
  text: string
  changed: boolean
}
export function removeManagedCodeWhaleHooks(
  configText: string,
  isManagedCommand: (command: string | undefined) => boolean
): {
  text: string
  changed: boolean
}
export function removeManagedCodeWhaleHooks(
  configText: string,
  isManagedCommand?: (command: string | undefined) => boolean
): {
  text: string
  changed: boolean
} {
  const stripped = stripManagedCodeWhaleHooks(configText, isManagedCommand)
  if (stripped === configText) {
    return { text: configText, changed: false }
  }
  const trimmed = stripped.replace(/\s+$/, '')
  return { text: trimmed.length > 0 ? `${trimmed}\n` : '', changed: true }
}

export function readManagedCodeWhaleHookEvents(
  configText: string,
  isManagedCommand: (command: string | undefined) => boolean
): Set<string> {
  const present = new Set<string>()
  const match = configText.match(MANAGED_BLOCK_RE)
  if (!match) {
    return present
  }
  const blockText = match[0]
  for (const chunk of blockText.split('[[hooks.hooks]]').slice(1)) {
    const event = readTomlStringField(chunk, 'event')
    const command = readTomlStringField(chunk, 'command')
    if (event && isManagedCommand(command)) {
      present.add(event)
    }
  }
  return present
}
