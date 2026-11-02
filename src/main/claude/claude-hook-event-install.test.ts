import { describe, expect, it } from 'vitest'
import type { HooksConfig } from '../agent-hooks/installer-utils'
import fixture from './__fixtures__/claude-hook-event-enums.json'
import { CLAUDE_HOOK_EVENT_FIRST_VERSIONS } from './claude-hook-event-versions'
import { getClaudeManagedHookPlan } from './claude-managed-hook-events'
import { applyManagedHooks } from './hook-settings'

const SCRIPT_FILE_NAME = 'claude-hook.sh'
const MANAGED_COMMAND = '/home/dev/.orca/agent-hooks/claude-hook.sh'
const managedHook = { type: 'command' as const, command: MANAGED_COMMAND }
const enums: Record<string, string[]> = fixture.enums
const topLevelSettings: Record<string, { keys: string[] }> = fixture.topLevelSettings

function install(config: HooksConfig, claudeVersion: string | undefined): HooksConfig {
  return applyManagedHooks(
    config,
    () => managedHook,
    SCRIPT_FILE_NAME,
    getClaudeManagedHookPlan(claudeVersion)
  )
}

function managedEvents(config: HooksConfig): string[] {
  return Object.entries(config.hooks ?? {})
    .filter(([, definitions]) =>
      (definitions ?? []).some((definition) =>
        (definition.hooks ?? []).some((hook) => hook.command === MANAGED_COMMAND)
      )
    )
    .map(([event]) => event)
    .sort()
}

const userHook = (event: string) => ({
  hooks: [{ type: 'command' as const, command: `echo user-${event}` }]
})

// Why: the user owns every event, managed or not, plus the keys an invalid file would discard.
function userOwnedSettings(): HooksConfig {
  const events = [...Object.keys(CLAUDE_HOOK_EVENT_FIRST_VERSIONS), 'Notification']
  return {
    env: { CLAUDE_CODE_USE_BEDROCK: '1' },
    permissions: { allow: ['Bash(git status)'] },
    hooks: Object.fromEntries(events.map((event) => [event, [userHook(event)]]))
  }
}

function expectUserSettingsKept(config: HooksConfig): void {
  expect(config.env).toEqual({ CLAUDE_CODE_USE_BEDROCK: '1' })
  expect(config.permissions).toEqual({ allow: ['Bash(git status)'] })
  for (const [event, definitions] of Object.entries(userOwnedSettings().hooks ?? {})) {
    expect(config.hooks?.[event], event).toContainEqual(definitions?.[0])
  }
}

describe('Claude managed hook events by resolved version', () => {
  it.each(Object.keys(enums))('writes only events Claude %s knows', (version) => {
    const written = install({ hooks: {} }, version)
    const unknown = Object.keys(written.hooks ?? {}).filter(
      (event) => !enums[version].includes(event)
    )
    expect(unknown).toEqual([])
  })

  it.each(Object.keys(topLevelSettings))(
    'writes statusLine only if Claude %s knows it',
    (version) => {
      const plan = getClaudeManagedHookPlan(version)
      expect(plan.statusLine === 'install').toBe(
        topLevelSettings[version].keys.includes('statusLine')
      )
    }
  )

  it('omits every event newer than an old Claude', () => {
    expect(managedEvents(install({ hooks: {} }, '2.1.32 (Claude Code)'))).toEqual(
      [
        'PermissionRequest',
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'SubagentStart',
        'SubagentStop',
        'UserPromptSubmit'
      ].sort()
    )
  })

  it.each([undefined, 'unknown'])(
    'writes only the core lifecycle events when the version is %s',
    (version) => {
      expect(managedEvents(install({ hooks: {} }, version))).toEqual(
        [
          'PostToolUse',
          'PreToolUse',
          'SessionStart',
          'Stop',
          'SubagentStop',
          'UserPromptSubmit'
        ].sort()
      )
    }
  )

  it.each([undefined, 'unknown'])(
    'leaves Orca entries a version-aware install wrote untouched when the version is %s',
    (version) => {
      const current = install(userOwnedSettings(), '2.1.261')
      expect(JSON.stringify(install(current, version))).toBe(JSON.stringify(current))

      // Why: even an entry from an older hook command stays byte-identical; only a known version may rewrite it.
      const staleHook = {
        type: 'command' as const,
        command: '/old/.orca/agent-hooks/claude-hook.sh'
      }
      const stale = { hooks: { StopFailure: [{ hooks: [staleHook] }] } }
      const written = install(stale, version)
      expect(JSON.stringify(written.hooks?.StopFailure)).toBe(
        JSON.stringify(stale.hooks.StopFailure)
      )
      expect(managedEvents(written)).toEqual(
        [
          'PostToolUse',
          'PreToolUse',
          'SessionStart',
          'Stop',
          'SubagentStop',
          'UserPromptSubmit'
        ].sort()
      )
    }
  )

  it('adds the newer events once the resolved Claude is upgraded', () => {
    const old = install({ hooks: {} }, '2.1.77')
    expect(old.hooks?.StopFailure).toBeUndefined()

    const upgraded = install(old, '2.1.78')

    expect(managedEvents(upgraded)).toContain('StopFailure')
    expect(managedEvents(upgraded)).toContain('PostCompact')
    expect(upgraded.hooks?.StopFailure).toEqual([{ hooks: [managedHook] }])
  })

  it('removes only Orca entries for events a downgraded Claude does not know', () => {
    const current = install({ hooks: {} }, '2.1.261')
    expect(managedEvents(current)).toContain('SessionEnd')

    const downgraded = install(current, '2.1.32')

    for (const event of ['StopFailure', 'PostCompact', 'TeammateIdle', 'SessionEnd']) {
      expect(downgraded.hooks?.[event], event).toBeUndefined()
    }
  })

  it('gates a known Claude older than the unresolved-version set by its own enum', () => {
    expect(managedEvents(install({ hooks: {} }, '1.0.52'))).toEqual(
      ['PostToolUse', 'PreToolUse', 'Stop', 'SubagentStop'].sort()
    )
    const downgraded = install(install({ hooks: {} }, '2.1.261'), '1.0.22')
    expect(managedEvents(downgraded)).toEqual([])
  })

  it.each(['1.0.22', '1.0.52', '1.0.81', '2.1.32', '2.1.77', '2.1.78', '2.1.261', undefined])(
    'keeps every user-written entry and setting when installing for %s',
    (version) => {
      const fresh = install(userOwnedSettings(), version)
      expectUserSettingsKept(fresh)
      // Why: a downgrade from the newest set is the path that removes Orca entries.
      expectUserSettingsKept(install(install(userOwnedSettings(), '2.1.261'), version))
    }
  )

  it('leaves a user value it cannot parse under an unknown event untouched', () => {
    const settings: HooksConfig = JSON.parse('{"hooks":{"StopFailure":[],"PostCompact":"mine"}}')
    const written = install(settings, '2.1.32')
    expect(written.hooks?.StopFailure).toEqual([])
    expect(written.hooks?.PostCompact).toBe('mine')
  })

  it('keeps SessionEnd behind its measured 2.1.261 floor', () => {
    expect(install({ hooks: {} }, '2.1.260').hooks?.SessionEnd).toBeUndefined()
    expect(install({ hooks: {} }, '2.1.261').hooks?.SessionEnd).toEqual([{ hooks: [managedHook] }])
  })
})
