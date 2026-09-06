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

  it('preserves user TOML appended after an orphaned block (#18861)', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND)
    // User appends their own hook table and tool table after the block, then
    // the trailing BLOCK_END marker is lost to a hand-edit.
    const orphanedWithUserTail = installed
      .replace(/\n# <<< orca-managed-kimi-hooks <<<\n?/, '\n')
      .concat(
        '[[hooks]]\n',
        'event = "SessionStart"\n',
        'command = "node my-own-hook.mjs"\n',
        '\n',
        '[[tools]]\n',
        'name = "user-tool"\n'
      )

    // Remove strips the orphaned installer-shaped tables and nothing else.
    const removed = removeManagedKimiHooks(orphanedWithUserTail)
    expect(removed.changed).toBe(true)
    expect(removed.text).toContain('event = "SessionStart"')
    expect(removed.text).toContain('node my-own-hook.mjs')
    expect(removed.text).toContain('[[tools]]')
    expect(removed.text).toContain('name = "user-tool"')
    expect(removed.text).not.toContain('orca-managed-kimi-hooks')
    expect(removed.text).not.toContain(COMMAND)

    // Reinstall still converges to one block and keeps the user tail intact.
    const reinstalled = applyManagedKimiHooks(orphanedWithUserTail, COMMAND)
    expect((reinstalled.match(/orca-managed-kimi-hooks \(/g) ?? []).length).toBe(1)
    expect(reinstalled).toContain('name = "user-tool"')
    expect(reinstalled).toContain('node my-own-hook.mjs')
  })

  it('recovers a CRLF-saved orphaned block and keeps the user tail (#18861)', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND)
    // The BLOCK_END hand-edit happened before an editor resaved the file with
    // Windows line endings.
    const orphanedCrlf = installed
      .replace(/\n# <<< orca-managed-kimi-hooks <<<\n?/, '\r\n')
      .concat(
        '[[hooks]]\r\n',
        'event = "SessionStart"\r\n',
        'command = "node my-own-hook.mjs"\r\n',
        '\r\n',
        '[[tools]]\r\n',
        'name = "user-tool"\r\n'
      )

    const removed = removeManagedKimiHooks(orphanedCrlf)
    expect(removed.changed).toBe(true)
    expect(removed.text).toContain('node my-own-hook.mjs')
    expect(removed.text).toContain('[[tools]]')
    expect(removed.text).not.toContain(COMMAND)
    // Orphaned installer tables behind CRLF are still recognized as managed.
    expect(readManagedKimiHookEvents(orphanedCrlf, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
  })

  it('keeps a user hook table that extends the installer shape intact (#18861)', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND)
    // A user table reusing the installer field order (event/command/timeout)
    // but carrying extra keys must not be read as installer-shaped: recovery
    // would otherwise delete its header and known fields and detach the rest.
    const orphanedWithExtendedTable = installed
      .replace(/\n# <<< orca-managed-kimi-hooks <<<\n?/, '\n')
      .concat(
        '[[hooks]]\n',
        'event = "SessionStart"\n',
        'command = "node my-own-hook.mjs"\n',
        'timeout = 120\n',
        'priority = 1\n'
      )

    const removed = removeManagedKimiHooks(orphanedWithExtendedTable)
    expect(removed.changed).toBe(true)
    // The orphaned installer-shaped tables are still stripped...
    expect(removed.text).not.toContain(COMMAND)
    expect(removed.text).not.toContain('orca-managed-kimi-hooks')
    // ...while the extended user table survives complete, header included.
    expect(removed.text).toContain('[[hooks]]')
    expect(removed.text).toContain('event = "SessionStart"')
    expect(removed.text).toContain('command = "node my-own-hook.mjs"')
    expect(removed.text).toContain('timeout = 120')
    expect(removed.text).toContain('priority = 1')
    expect(readManagedKimiHookEvents(removed.text, isManaged).size).toBe(0)

    // Reinstall still converges to one block beside the extended user table.
    const reinstalled = applyManagedKimiHooks(orphanedWithExtendedTable, COMMAND)
    expect((reinstalled.match(/orca-managed-kimi-hooks \(/g) ?? []).length).toBe(1)
    expect(reinstalled).toContain('priority = 1')
  })

  it('declines orphan recovery when the first table after the marker extends the installer shape (#18861)', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND)
    // With no fully installer-shaped table after the orphaned marker, recovery
    // must decline entirely rather than delete an extended table's prefix.
    const blockStart = installed.match(/# >>> orca-managed-kimi-hooks[^\n]*/)?.[0] ?? ''
    const orphanedExtendedOnly = [
      'default_model = "x"',
      '',
      blockStart,
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "node my-own-hook.mjs"',
      'timeout = 120',
      'priority = 1',
      ''
    ].join('\n')

    expect(removeManagedKimiHooks(orphanedExtendedOnly)).toEqual({
      text: orphanedExtendedOnly,
      changed: false
    })
  })

  it('recovers an orphaned block whose user TOML starts after a blank line (#18861)', () => {
    for (const nl of ['\n', '\r\n']) {
      const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND)
      // A blank line separates the last orphaned table from the user's
      // appended section: recovery must still strip the orphan instead of
      // leaving it behind for reinstall to duplicate.
      const orphaned = installed
        .replace(/\n# <<< orca-managed-kimi-hooks <<<\n?/, nl)
        .concat(nl, `[tools]${nl}`, `name = "user-tool"${nl}`)

      const removed = removeManagedKimiHooks(orphaned)
      expect(removed.changed).toBe(true)
      expect(removed.text).toContain('[tools]')
      expect(removed.text).toContain('name = "user-tool"')
      expect(removed.text).not.toContain(COMMAND)
      expect(readManagedKimiHookEvents(removed.text, isManaged).size).toBe(0)

      const reinstalled = applyManagedKimiHooks(orphaned, COMMAND)
      expect((reinstalled.match(/orca-managed-kimi-hooks \(/g) ?? []).length).toBe(1)
    }
  })

  it('recovers an orphaned block followed by a comment line and keeps the comment intact (#18861)', () => {
    for (const nl of ['\n', '\r\n']) {
      const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND)
      // A `#` comment ahead of the user's appended TOML must not strand the
      // last orphaned table: partial removal reports changed=true while
      // leaving a live managed hook command behind.
      const orphaned = installed
        .replace(/\n# <<< orca-managed-kimi-hooks <<<\n?/, '\n')
        .concat(
          `# my own hooks${nl}`,
          `[[hooks]]${nl}`,
          `event = "SessionStart"${nl}`,
          `command = "node my-own-hook.mjs"${nl}`,
          `timeout = 120${nl}`,
          `priority = 1${nl}`
        )

      const removed = removeManagedKimiHooks(orphaned)
      expect(removed.changed).toBe(true)
      expect(removed.text).toContain('# my own hooks')
      expect(removed.text).toContain('priority = 1')
      expect(removed.text).not.toContain(COMMAND)
      expect(readManagedKimiHookEvents(removed.text, isManaged).size).toBe(0)

      const reinstalled = applyManagedKimiHooks(orphaned, COMMAND)
      expect((reinstalled.match(/orca-managed-kimi-hooks \(/g) ?? []).length).toBe(1)
      expect(reinstalled).toContain('# my own hooks')
      expect(reinstalled).toContain('priority = 1')
    }
  })

  it('recovers an orphaned block whose only trailing content is a comment (#18861)', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND)
    const orphaned = installed
      .replace(/\n# <<< orca-managed-kimi-hooks <<<\n?/, '\n')
      .concat('# trailing note')

    const removed = removeManagedKimiHooks(orphaned)
    expect(removed.changed).toBe(true)
    expect(removed.text).toContain('# trailing note')
    expect(removed.text).not.toContain(COMMAND)
    expect(readManagedKimiHookEvents(removed.text, isManaged).size).toBe(0)
  })

  it('keeps a hook table extended behind a comment line intact (#18861)', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND)
    // A comment does not close a TOML table: `priority` below extends the
    // installer-shaped table above it, so recovery must leave it alone rather
    // than strip its header and detach the key.
    const orphaned = installed
      .replace(/\n# <<< orca-managed-kimi-hooks <<<\n?/, '\n')
      .concat('# knob\n', 'priority = 1\n', '[tools]\n', 'name = "user-tool"\n')

    const removed = removeManagedKimiHooks(orphaned)
    expect(removed.changed).toBe(true)
    expect(removed.text).not.toContain('orca-managed-kimi-hooks')
    expect(removed.text).toContain('# knob')
    expect(removed.text).toContain('priority = 1')
    expect(removed.text).toContain('[tools]')
  })

  it('treats stale managed entries pointing at a moved script path as managed', () => {
    const staleCommand =
      "if [ -x '/old/userData/agent-hooks/kimi-hook.sh' ]; then /bin/sh '/old/userData/agent-hooks/kimi-hook.sh'; fi"
    const stale = applyManagedKimiHooks('', staleCommand)
    expect(readManagedKimiHookEvents(stale, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
  })
})
