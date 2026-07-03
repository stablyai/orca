import { describe, expect, it } from 'vitest'
import {
  applyManagedKimiHooks,
  buildManagedKimiHooksBlock,
  KIMI_HOOK_EVENTS,
  readManagedKimiHookEvents,
  removeManagedKimiHooks
} from './kimi-hook-config-toml'

const COMMAND =
  "if [ -x '/home/u/.orca/agent-hooks/kimi-hook.sh' ]; then /bin/sh '/home/u/.orca/agent-hooks/kimi-hook.sh'; fi"
const isManaged = (command: string | undefined): boolean =>
  typeof command === 'string' && command.includes('agent-hooks/kimi-hook.sh')

describe('kimi managed hooks TOML block', () => {
  it('installs every managed event without a matcher', () => {
    const block = buildManagedKimiHooksBlock(COMMAND)
    for (const event of KIMI_HOOK_EVENTS) {
      expect(block).toContain(`event = "${event}"`)
    }
    // Kimi treats matcher as a regex; omitting it matches all tools.
    expect(block).not.toContain('matcher')
    expect(readManagedKimiHookEvents(applyManagedKimiHooks('', COMMAND), isManaged)).toEqual(
      new Set(KIMI_HOOK_EVENTS)
    )
  })

  it('preserves existing user config above the managed block', () => {
    const userConfig = [
      'default_model = "kimi-k2.6"',
      '',
      '[providers."mine"]',
      'type = "openai"',
      'base_url = "https://example.com/v1"',
      'api_key = "sk-secret"',
      '',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "node my-own-hook.mjs"',
      ''
    ].join('\n')

    const next = applyManagedKimiHooks(userConfig, COMMAND)
    expect(next).toContain('default_model = "kimi-k2.6"')
    expect(next).toContain('api_key = "sk-secret"')
    // The user's own hook survives untouched.
    expect(next).toContain('command = "node my-own-hook.mjs"')
    expect(readManagedKimiHookEvents(next, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
  })

  it('is idempotent — reinstalling does not duplicate the block', () => {
    const once = applyManagedKimiHooks('default_model = "x"\n', COMMAND)
    const twice = applyManagedKimiHooks(once, COMMAND)
    expect(twice).toBe(once)
    const markerCount = (twice.match(/orca-managed-kimi-hooks \(/g) ?? []).length
    expect(markerCount).toBe(1)
  })

  it('removes the managed block and restores the user config', () => {
    const userConfig = 'default_model = "kimi-k2.6"\n'
    const installed = applyManagedKimiHooks(userConfig, COMMAND)
    const { text, changed } = removeManagedKimiHooks(installed)
    expect(changed).toBe(true)
    expect(text).toBe(userConfig)
    expect(readManagedKimiHookEvents(text, isManaged).size).toBe(0)
  })

  it('reports no change when removing from a config without the managed block', () => {
    const { text, changed } = removeManagedKimiHooks('default_model = "x"\n')
    expect(changed).toBe(false)
    expect(text).toBe('default_model = "x"\n')
  })

  it('is stable across repeated calls (no stateful global-regex lastIndex drift)', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND)
    // Repeated detection/removal on the same and on a clean input must be
    // consistent — a `g`-flagged .test() would drift lastIndex and flip results.
    expect(removeManagedKimiHooks(installed).changed).toBe(true)
    expect(removeManagedKimiHooks(installed).changed).toBe(true)
    expect(removeManagedKimiHooks('default_model = "x"\n').changed).toBe(false)
    expect(removeManagedKimiHooks(installed).changed).toBe(true)
    expect(readManagedKimiHookEvents(installed, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
    expect(readManagedKimiHookEvents(installed, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
  })

  it('recovers when a hand-edit deletes only the trailing end marker', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND)
    // Simulate a user deleting just the `# <<< ... <<<` end-marker line.
    const orphaned = installed.replace(/\n# <<< orca-managed-kimi-hooks <<<\n?/, '\n')
    expect(orphaned).not.toContain('<<<')
    // The orphaned (still-active) hook tables are still recognized...
    expect(readManagedKimiHookEvents(orphaned, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
    // ...remove strips them...
    expect(removeManagedKimiHooks(orphaned)).toEqual({
      text: 'default_model = "x"\n',
      changed: true
    })
    // ...and reinstall converges to a single block instead of duplicating.
    const reinstalled = applyManagedKimiHooks(orphaned, COMMAND)
    expect((reinstalled.match(/orca-managed-kimi-hooks \(/g) ?? []).length).toBe(1)
  })

  it('treats stale managed entries pointing at a moved script path as managed', () => {
    const staleCommand =
      "if [ -x '/old/userData/agent-hooks/kimi-hook.sh' ]; then /bin/sh '/old/userData/agent-hooks/kimi-hook.sh'; fi"
    const stale = applyManagedKimiHooks('', staleCommand)
    expect(readManagedKimiHookEvents(stale, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
  })
})
