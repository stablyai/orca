import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import {
  applyManagedRovoHooks,
  readManagedRovoHookEvents,
  removeManagedRovoHooks,
  ROVO_HOOK_EVENTS
} from './rovo-hook-config-yaml'

const isManaged = createManagedCommandMatcher('rovo-hook.sh')
const COMMAND = "/bin/sh '/home/u/.orca/agent-hooks/rovo-hook.sh'"

const USER_CONFIG = `# user settings
agent:
  modelId: auto
eventHooks:
  logFile: /home/u/.rovo/event_hooks.log
  events:
  - name: on_complete
    commands:
    # keep me
    - command: \${HOME}/.rovo/hooks/agent-status.sh on_complete
  - name: on_session_end
    commands:
    - command: /usr/local/bin/aicodemetricsd hook rovo
`

type EventEntry = { name: string; commands: { command: string }[] }

function isEventEntry(value: unknown): value is EventEntry {
  return typeof value === 'object' && value !== null && 'name' in value && 'commands' in value
}

function eventsOf(text: string): EventEntry[] {
  const parsed: unknown = parse(text)
  const events =
    typeof parsed === 'object' && parsed !== null && 'eventHooks' in parsed
      ? parsed.eventHooks
      : undefined
  const list =
    typeof events === 'object' && events !== null && 'events' in events ? events.events : []
  return Array.isArray(list) ? list.filter(isEventEntry) : []
}

describe('Rovo config.yml managed hooks', () => {
  it('adds the managed command to every hooked event while preserving user hooks and comments', () => {
    const next = applyManagedRovoHooks(USER_CONFIG, COMMAND, isManaged)

    expect(next).toContain('# user settings')
    expect(next).toContain('# keep me')
    expect(next).toContain('logFile: /home/u/.rovo/event_hooks.log')
    const events = eventsOf(next)
    expect(events.find((e) => e.name === 'on_complete')?.commands.map((c) => c.command)).toEqual([
      '${HOME}/.rovo/hooks/agent-status.sh on_complete',
      COMMAND
    ])
    expect(events.find((e) => e.name === 'on_session_end')?.commands).toHaveLength(1)
    expect(readManagedRovoHookEvents(next, isManaged)).toEqual(new Set(ROVO_HOOK_EVENTS))
  })

  it('is idempotent and replaces stale managed commands from older installs', () => {
    const stale = applyManagedRovoHooks(
      USER_CONFIG,
      "/bin/sh '/old/agent-hooks/rovo-hook.sh'",
      isManaged
    )
    const once = applyManagedRovoHooks(stale, COMMAND, isManaged)
    expect(applyManagedRovoHooks(once, COMMAND, isManaged)).toBe(once)
    expect(once).not.toContain('/old/agent-hooks/')
  })

  it('creates eventHooks in an empty config', () => {
    const next = applyManagedRovoHooks('', COMMAND, isManaged)
    expect(eventsOf(next).map((e) => e.name)).toEqual([...ROVO_HOOK_EVENTS])
  })

  it('removes only managed commands and drops entries that held nothing else', () => {
    const installed = applyManagedRovoHooks(USER_CONFIG, COMMAND, isManaged)
    const { text, changed } = removeManagedRovoHooks(installed, isManaged)

    expect(changed).toBe(true)
    expect(eventsOf(text).map((e) => e.name)).toEqual(['on_complete', 'on_session_end'])
    expect(text).toContain('agent-status.sh on_complete')
    expect(readManagedRovoHookEvents(text, isManaged).size).toBe(0)
    expect(removeManagedRovoHooks(USER_CONFIG, isManaged)).toEqual({
      text: USER_CONFIG,
      changed: false
    })
  })

  it('refuses to edit malformed or unexpected shapes', () => {
    expect(() => applyManagedRovoHooks('eventHooks: [oops', COMMAND, isManaged)).toThrow()
    expect(() =>
      applyManagedRovoHooks('eventHooks:\n  events: nope\n', COMMAND, isManaged)
    ).toThrow('eventHooks.events must be a list')
  })
})
