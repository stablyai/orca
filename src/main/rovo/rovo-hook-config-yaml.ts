import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Document, YAMLMap, YAMLSeq } from 'yaml'

// Why: Rovo has no stop-equivalent besides on_complete/on_error; on_session_start
// reports the session id before the first prompt so resume/session tracking binds early.
export const ROVO_HOOK_EVENTS = [
  'on_session_start',
  'on_user_prompt',
  'on_tool_start',
  'on_tool_permission',
  'on_tool_end',
  'on_complete',
  'on_error'
] as const

export type ManagedCommandMatcher = (command: string | undefined) => boolean

type ParsedConfig = { document: Document; root: YAMLMap }

// Why: Rovo (PyYAML) writes block lists flush with their parent key; keep whichever style the file uses.
function serializeConfig(document: Document, originalText: string): string {
  const indentSeq = !/^( *)[^\s#-][^\n]*:[ \t]*\r?\n\1- /m.test(originalText)
  return document.toString({ indentSeq, lineWidth: 0 })
}

function parseConfigDocument(configText: string): ParsedConfig {
  const document: Document = parseDocument(configText)
  const problems = [...document.errors, ...document.warnings]
  if (problems.length > 0) {
    throw new Error(problems.map((item) => item.message).join('; '))
  }
  if (
    document.contents === null ||
    (isScalar(document.contents) && document.contents.value === null)
  ) {
    document.contents = document.createNode({})
  }
  if (!isMap(document.contents)) {
    throw new Error('Rovo config.yml root must be a mapping')
  }
  return { document, root: document.contents }
}

function readCommand(item: unknown): string | undefined {
  if (!isMap(item)) {
    return undefined
  }
  const command = item.get('command')
  return typeof command === 'string' ? command : undefined
}

function readEventName(entry: unknown): string | undefined {
  if (!isMap(entry)) {
    return undefined
  }
  const name = entry.get('name')
  return typeof name === 'string' ? name : undefined
}

function getEventsSeq({ document, root }: ParsedConfig, create: boolean): YAMLSeq | null {
  let eventHooks = root.get('eventHooks', true)
  if (eventHooks === undefined || (isScalar(eventHooks) && eventHooks.value === null)) {
    if (!create) {
      return null
    }
    root.set('eventHooks', document.createNode({ events: [] }))
    eventHooks = root.get('eventHooks', true)
  }
  if (!isMap(eventHooks)) {
    throw new Error('Rovo eventHooks must be a mapping')
  }
  let events = eventHooks.get('events', true)
  if (events === undefined || (isScalar(events) && events.value === null)) {
    if (!create) {
      return null
    }
    eventHooks.set('events', document.createNode([]))
    events = eventHooks.get('events', true)
  }
  if (!isSeq(events)) {
    throw new Error('Rovo eventHooks.events must be a list')
  }
  return events
}

// Removes managed commands and drops event entries that only held them; returns whether anything changed.
function stripManagedCommands(events: YAMLSeq, isManagedCommand: ManagedCommandMatcher): boolean {
  let changed = false
  events.items = events.items.filter((entry) => {
    if (!isMap(entry)) {
      return true
    }
    const commands = entry.get('commands', true)
    if (!isSeq(commands)) {
      return true
    }
    const before = commands.items.length
    commands.items = commands.items.filter((item) => !isManagedCommand(readCommand(item)))
    if (commands.items.length === before) {
      return true
    }
    changed = true
    return commands.items.length > 0
  })
  return changed
}

export function applyManagedRovoHooks(
  configText: string,
  command: string,
  isManagedCommand: ManagedCommandMatcher
): string {
  const parsed = parseConfigDocument(configText)
  const { document } = parsed
  const events = getEventsSeq(parsed, true)
  if (!events) {
    throw new Error('Could not create Rovo eventHooks.events')
  }
  stripManagedCommands(events, isManagedCommand)
  for (const eventName of ROVO_HOOK_EVENTS) {
    const entry = events.items.find((item) => readEventName(item) === eventName)
    const managed = document.createNode({ command })
    if (!isMap(entry)) {
      events.add(document.createNode({ name: eventName, commands: [managed] }))
      continue
    }
    const commands = entry.get('commands', true)
    if (isSeq(commands)) {
      commands.add(managed)
    } else if (commands === undefined || (isScalar(commands) && commands.value === null)) {
      entry.set('commands', document.createNode([managed]))
    } else {
      throw new Error(`Rovo eventHooks ${eventName}.commands must be a list`)
    }
  }
  return serializeConfig(document, configText)
}

export function removeManagedRovoHooks(
  configText: string,
  isManagedCommand: ManagedCommandMatcher
): { text: string; changed: boolean } {
  const parsed = parseConfigDocument(configText)
  const events = getEventsSeq(parsed, false)
  if (!events || !stripManagedCommands(events, isManagedCommand)) {
    return { text: configText, changed: false }
  }
  return { text: serializeConfig(parsed.document, configText), changed: true }
}

export function readManagedRovoHookEvents(
  configText: string,
  isManagedCommand: ManagedCommandMatcher
): Set<string> {
  const present = new Set<string>()
  const events = getEventsSeq(parseConfigDocument(configText), false)
  for (const entry of events?.items ?? []) {
    const name = readEventName(entry)
    const commands = isMap(entry) ? entry.get('commands', true) : undefined
    if (
      name &&
      isSeq(commands) &&
      commands.items.some((item) => isManagedCommand(readCommand(item)))
    ) {
      present.add(name)
    }
  }
  return present
}
