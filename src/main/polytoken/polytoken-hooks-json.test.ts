import { describe, expect, it } from 'vitest'
import {
  applyManagedPolytokenHooks,
  isOrcaManagedPolytokenHookEntry,
  managedPolytokenHookName,
  parsePolytokenHooksJson,
  POLYTOKEN_HOOK_EVENTS,
  readManagedPolytokenHookEvents,
  removeManagedPolytokenHooks,
  serializePolytokenHooksJson
} from './polytoken-hooks-json'

const COMMAND =
  "if [ -x '/home/u/.orca/agent-hooks/polytoken-hook.sh' ]; then /bin/sh '/home/u/.orca/agent-hooks/polytoken-hook.sh'; fi"

// Why: mirrors a real user file — a third-party bridge plus entries from an earlier Orca build.
const FOREIGN = [
  { name: 'orca-pi-bridge-session-start', event: 'session_start', handler: { bash: 'bridge.sh' } },
  { name: 'notify-discord', event: 'stop', matcher: 'stop', handler: { bash: 'discord.sh' } }
]
const LEGACY = [
  { name: 'orca-managed-stop', event: 'stop', handler: { bash: 'old-orca.sh' } },
  { name: 'orca-managed-notification', event: 'notification', handler: { bash: 'old-orca.sh' } }
]

describe('parsePolytokenHooksJson', () => {
  it('treats an absent or blank file as an empty array', () => {
    expect(parsePolytokenHooksJson('')).toEqual({ ok: true, entries: [] })
    expect(parsePolytokenHooksJson('﻿  \n')).toEqual({ ok: true, entries: [] })
  })

  it('fails closed on malformed JSON, non-arrays, and non-object entries', () => {
    expect(parsePolytokenHooksJson('[{')).toMatchObject({ ok: false })
    expect(parsePolytokenHooksJson('{"hooks":[]}')).toMatchObject({ ok: false })
    expect(parsePolytokenHooksJson('[1]')).toMatchObject({ ok: false })
    expect(parsePolytokenHooksJson('[[]]')).toMatchObject({ ok: false })
  })
})

describe('applyManagedPolytokenHooks', () => {
  it('appends one Orca-owned entry per registered event after every foreign entry', () => {
    const entries = applyManagedPolytokenHooks(FOREIGN, COMMAND)
    expect(entries.slice(0, FOREIGN.length)).toEqual(FOREIGN)
    expect(entries.slice(FOREIGN.length).map((entry) => entry.name)).toEqual(
      POLYTOKEN_HOOK_EVENTS.map(managedPolytokenHookName)
    )
    expect(entries.at(-1)).toEqual({
      name: 'orca-managed-polytoken-stop',
      event: 'stop',
      handler: { bash: COMMAND }
    })
  })

  it('does not register notification, compaction, or post_model_turn hooks', () => {
    const events = applyManagedPolytokenHooks([], COMMAND).map((entry) => entry.event)
    for (const excluded of ['notification', 'post_model_turn', 'pre_compaction', 'post_clear']) {
      expect(events).not.toContain(excluded)
    }
  })

  it('is idempotent and replaces legacy orca-managed-<event> entries in place of duplicating them', () => {
    const once = applyManagedPolytokenHooks([...FOREIGN, ...LEGACY], COMMAND)
    const twice = applyManagedPolytokenHooks(once, COMMAND)
    expect(serializePolytokenHooksJson(twice)).toBe(serializePolytokenHooksJson(once))
    expect(twice.filter((entry) => entry.event === 'stop')).toHaveLength(2)
    expect(twice.some((entry) => entry.name === 'orca-managed-stop')).toBe(false)
  })
})

describe('removeManagedPolytokenHooks', () => {
  it('removes only Orca-owned entries and reports whether anything changed', () => {
    const installed = applyManagedPolytokenHooks([...FOREIGN, ...LEGACY], COMMAND)
    const removed = removeManagedPolytokenHooks(installed)
    expect(removed).toEqual({ entries: FOREIGN, changed: true })
    expect(removeManagedPolytokenHooks(FOREIGN)).toEqual({ entries: FOREIGN, changed: false })
    expect(isOrcaManagedPolytokenHookEntry({ name: 'orca-managed-polytoken-x' })).toBe(true)
    expect(isOrcaManagedPolytokenHookEntry({ name: 'orca-managed-notification' })).toBe(true)
    expect(isOrcaManagedPolytokenHookEntry({ name: 'orca-managed-claude-stop' })).toBe(false)
  })
})

describe('readManagedPolytokenHookEvents', () => {
  it('reports only owned entries whose handler still points at the managed script', () => {
    const entries = [
      ...applyManagedPolytokenHooks(FOREIGN, COMMAND),
      { name: 'orca-managed-polytoken-stop', event: 'stop', handler: { bash: 'elsewhere.sh' } },
      { name: 'orca-managed-polytoken-broken', event: 'stop', handler: 'not-an-object' }
    ]
    const present = readManagedPolytokenHookEvents(entries, (command) =>
      Boolean(command?.includes('polytoken-hook.sh'))
    )
    expect([...present].sort()).toEqual([...POLYTOKEN_HOOK_EVENTS].sort())
  })
})
