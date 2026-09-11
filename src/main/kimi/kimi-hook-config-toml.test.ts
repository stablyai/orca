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

const END_MARKER_LINE = '# <<< orca-managed-kimi-hooks <<<'
const START_MARKER = '# >>> orca-managed-kimi-hooks (managed by Orca; do not edit) >>>'

/** Drops only the `# <<< ... <<<` line, the hand-edit that orphans the block. */
function deleteEndMarker(text: string): string {
  return text.replace(/\r?\n# <<< orca-managed-kimi-hooks <<<(?=\r?\n|$)/, '')
}

describe('kimi managed hooks TOML block', () => {
  it('installs every managed event without a matcher', () => {
    const block = buildManagedKimiHooksBlock(COMMAND)
    for (const event of KIMI_HOOK_EVENTS) {
      expect(block).toContain(`event = "${event}"`)
    }
    // Kimi treats matcher as a regex; omitting it matches all tools.
    expect(block).not.toContain('matcher')
    expect(
      readManagedKimiHookEvents(applyManagedKimiHooks('', COMMAND, isManaged), isManaged)
    ).toEqual(new Set(KIMI_HOOK_EVENTS))
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

    const next = applyManagedKimiHooks(userConfig, COMMAND, isManaged)
    expect(next).toContain('default_model = "kimi-k2.6"')
    expect(next).toContain('api_key = "sk-secret"')
    // The user's own hook survives untouched.
    expect(next).toContain('command = "node my-own-hook.mjs"')
    expect(readManagedKimiHookEvents(next, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
  })

  it('is idempotent — reinstalling does not duplicate the block', () => {
    const once = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    const twice = applyManagedKimiHooks(once, COMMAND, isManaged)
    expect(twice).toBe(once)
    const markerCount = (twice.match(/orca-managed-kimi-hooks \(/g) ?? []).length
    expect(markerCount).toBe(1)
  })

  it('removes the managed block and restores the user config', () => {
    const userConfig = 'default_model = "kimi-k2.6"\n'
    const installed = applyManagedKimiHooks(userConfig, COMMAND, isManaged)
    const { text, changed } = removeManagedKimiHooks(installed, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe(userConfig)
    expect(readManagedKimiHookEvents(text, isManaged).size).toBe(0)
  })

  it('reports no change when removing from a config without the managed block', () => {
    const { text, changed } = removeManagedKimiHooks('default_model = "x"\n', isManaged)
    expect(changed).toBe(false)
    expect(text).toBe('default_model = "x"\n')
  })

  it('is stable across repeated calls (no stateful global-regex lastIndex drift)', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    // Repeated detection/removal on the same and on a clean input must be
    // consistent — a `g`-flagged .test() would drift lastIndex and flip results.
    expect(removeManagedKimiHooks(installed, isManaged).changed).toBe(true)
    expect(removeManagedKimiHooks(installed, isManaged).changed).toBe(true)
    expect(removeManagedKimiHooks('default_model = "x"\n', isManaged).changed).toBe(false)
    expect(removeManagedKimiHooks(installed, isManaged).changed).toBe(true)
    expect(readManagedKimiHookEvents(installed, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
    expect(readManagedKimiHookEvents(installed, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
  })

  it('recovers when a hand-edit deletes only the trailing end marker', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    const orphaned = deleteEndMarker(installed)
    expect(orphaned).not.toContain('<<<')
    // The orphaned (still-active) hook tables are still recognized...
    expect(readManagedKimiHookEvents(orphaned, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
    // ...remove strips them...
    expect(removeManagedKimiHooks(orphaned, isManaged)).toEqual({
      text: 'default_model = "x"\n',
      changed: true
    })
    // ...and reinstall converges to a single block instead of duplicating.
    const reinstalled = applyManagedKimiHooks(orphaned, COMMAND, isManaged)
    expect((reinstalled.match(/orca-managed-kimi-hooks \(/g) ?? []).length).toBe(1)
  })

  it('treats stale managed entries pointing at a moved script path as managed', () => {
    const staleCommand =
      "if [ -x '/old/userData/agent-hooks/kimi-hook.sh' ]; then /bin/sh '/old/userData/agent-hooks/kimi-hook.sh'; fi"
    const stale = applyManagedKimiHooks('', staleCommand, isManaged)
    expect(readManagedKimiHookEvents(stale, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
  })
})

// #18861: an orphaned start marker used to make every following byte "managed".
describe('orphaned managed block ownership (#18861)', () => {
  const USER_TAIL = [
    '[providers."mine"]',
    'type = "openai"',
    'api_key = "sk-secret"',
    '',
    '[[hooks]]',
    'event = "Stop"',
    'command = "node my-own-hook.mjs"'
  ].join('\n')

  function orphanedWithUserTail(): string {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    return `${deleteEndMarker(installed)}\n${USER_TAIL}\n`
  }

  it('keeps user tables appended after an orphaned block through remove', () => {
    const { text, changed } = removeManagedKimiHooks(orphanedWithUserTail(), isManaged)
    expect(changed).toBe(true)
    expect(text).toContain('api_key = "sk-secret"')
    expect(text).toContain('command = "node my-own-hook.mjs"')
    expect(text).toContain('default_model = "x"')
    // The reclaimed managed tables and the stray marker are gone.
    expect(text).not.toContain(START_MARKER)
    expect(text).not.toContain('agent-hooks/kimi-hook.sh')
  })

  it('keeps user tables appended after an orphaned block through reinstall', () => {
    const reinstalled = applyManagedKimiHooks(orphanedWithUserTail(), COMMAND, isManaged)
    expect(reinstalled).toContain('api_key = "sk-secret"')
    expect(reinstalled).toContain('command = "node my-own-hook.mjs"')
    // Exactly one well-formed block, appended after the surviving user bytes.
    expect((reinstalled.match(/orca-managed-kimi-hooks \(/g) ?? []).length).toBe(1)
    expect(reinstalled.indexOf('sk-secret')).toBeLessThan(reinstalled.indexOf(START_MARKER))
    expect(readManagedKimiHookEvents(reinstalled, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
    // And a second install is a no-op, so the recovery converges.
    expect(applyManagedKimiHooks(reinstalled, COMMAND, isManaged)).toBe(reinstalled)
  })

  it('reclaims a genuinely managed orphan table but stops at the first user line', () => {
    const orphan = [
      'default_model = "x"',
      '',
      START_MARKER,
      '[[hooks]]',
      `event = "Stop"`,
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      '[hand.written]',
      'value = "keep"',
      ''
    ].join('\n')
    const { text, changed } = removeManagedKimiHooks(orphan, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe('default_model = "x"\n[hand.written]\nvalue = "keep"\n')
  })

  it('removes only the stray marker when an orphan owns no managed content', () => {
    const orphan = `default_model = "x"\n\n${START_MARKER}\n[user.table]\nvalue = "keep"\n`
    const { text, changed } = removeManagedKimiHooks(orphan, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe('default_model = "x"\n[user.table]\nvalue = "keep"\n')
  })

  it('does not treat a user [[hooks]] table as Orca-owned content', () => {
    const orphan = [
      START_MARKER,
      '[[hooks]]',
      'event = "Stop"',
      'command = "node my-own-hook.mjs"',
      'timeout = 10',
      ''
    ].join('\n')
    const { text } = removeManagedKimiHooks(orphan, isManaged)
    expect(text).toContain('command = "node my-own-hook.mjs"')
    expect(text).not.toContain(START_MARKER)
  })

  // A user adding keys has customised Orca's hook, not authored their own: the
  // command path is what makes it fire. Leaving it would keep sending Orca their
  // events after uninstall, and reinstall would double-fire the event.
  it('owns a managed table the user added an extra key to', () => {
    const orphan = [
      START_MARKER,
      '[[hooks]]',
      'event = "Stop"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      'matcher = "Bash"',
      ''
    ].join('\n')
    expect(removeManagedKimiHooks(orphan, isManaged).text).toBe('')
  })

  it('owns a customised managed table sitting outside any marker', () => {
    const customised = [
      'default_model = "x"',
      '',
      '[[hooks]]',
      'event = "Stop"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      'matcher = "Bash"',
      ''
    ].join('\n')
    expect(removeManagedKimiHooks(customised, isManaged).text).toBe('default_model = "x"\n')
    // Status agrees, so install cannot append a second table for the same event.
    expect(readManagedKimiHookEvents(customised, isManaged)).toEqual(new Set(['Stop']))
    const reinstalled = applyManagedKimiHooks(customised, COMMAND, isManaged)
    expect((reinstalled.match(/event = "Stop"/g) ?? []).length).toBe(1)
  })

  // Extent safety: a multi-line value means the table's end is not knowable by
  // line scanning, so splicing it would take the wrong bytes.
  it('fails closed on a table whose value spans lines', () => {
    const orphan = [
      START_MARKER,
      '[[hooks]]',
      'event = "Stop"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'args = [',
      '  "a"',
      ']',
      ''
    ].join('\n')
    const { text } = removeManagedKimiHooks(orphan, isManaged)
    expect(text).toContain('args = [')
    expect(text).not.toContain(START_MARKER)
  })

  // CodeRabbit on #20148: the old regex reader matched key *suffixes* and
  // commented-out keys. Keys are parsed exactly now; these must not register.
  it('does not read a managed event from key suffixes or commented keys', () => {
    const nearMiss = [
      START_MARKER,
      '[[hooks]]',
      'previous_event = "Stop"',
      `fallback_command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      END_MARKER_LINE,
      '',
      '[[hooks]]',
      '# event = "PreToolUse"',
      `# command = "${COMMAND.replaceAll('"', '')}"`,
      ''
    ].join('\n')
    expect(readManagedKimiHookEvents(nearMiss, isManaged)).toEqual(new Set())
  })

  // CodeRabbit on #20148: a blank or comment between keys does not end a TOML
  // table. Splicing the bounded run would strand `timeout` without its header.
  it('fails closed when more keys follow a gap inside the table', () => {
    for (const gap of ['', '# note']) {
      const orphan = [
        START_MARKER,
        '[[hooks]]',
        'event = "Stop"',
        `command = "${COMMAND.replaceAll('"', '')}"`,
        gap,
        'timeout = 10',
        ''
      ].join('\n')
      const { text } = removeManagedKimiHooks(orphan, isManaged)
      expect(text).toContain('timeout = 10')
      expect(text).toContain('[[hooks]]')
      expect(text).not.toContain(START_MARKER)
    }
  })

  it('still owns a table whose keys are followed by a gap and a new table', () => {
    const orphan = [
      START_MARKER,
      '[[hooks]]',
      'event = "Stop"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      '',
      '# a user comment',
      '',
      '[user.table]',
      'v = 1',
      ''
    ].join('\n')
    const { text } = removeManagedKimiHooks(orphan, isManaged)
    expect(text).not.toContain(START_MARKER)
    expect(text).not.toContain('agent-hooks/kimi-hook.sh')
    // The user's comment and table are theirs; only the managed table goes.
    expect(text).toContain('# a user comment')
    expect(text).toContain('[user.table]')
  })

  // pullfrog on #20148: ownership keys on `command`, so an `event` Orca cannot
  // parse must never let status claim nothing is installed.
  it('never reports not_installed for a table remove() would strip', () => {
    for (const eventLine of [`event = 'Stop'`, 'event = "Stop" # note', 'event = 12']) {
      const config = [
        START_MARKER,
        '[[hooks]]',
        eventLine,
        `command = "${COMMAND.replaceAll('"', '')}"`,
        'timeout = 10',
        END_MARKER_LINE,
        ''
      ].join('\n')
      // remove() strips it, so status must see it too.
      expect(removeManagedKimiHooks(config, isManaged).changed).toBe(true)
      expect(readManagedKimiHookEvents(config, isManaged).size).toBeGreaterThan(0)
    }
    // The single-quoted form resolves to the real event name.
    const singleQuoted = [
      START_MARKER,
      '[[hooks]]',
      `event = 'Stop'`,
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      END_MARKER_LINE,
      ''
    ].join('\n')
    expect(readManagedKimiHookEvents(singleQuoted, isManaged)).toEqual(new Set(['Stop']))
  })

  it('leaves a hook table that does not invoke the managed script', () => {
    const orphan = [
      START_MARKER,
      '[[hooks]]',
      'event = "Stop"',
      'command = "node my-own-hook.mjs"',
      'timeout = 10',
      'matcher = "Bash"',
      ''
    ].join('\n')
    const { text } = removeManagedKimiHooks(orphan, isManaged)
    expect(text).toContain('command = "node my-own-hook.mjs"')
    expect(text).toContain('matcher = "Bash"')
  })

  // A stranded managed table still executes, so remove() must reclaim it wherever
  // a hand-edit left it; only the user's own bytes are off limits.
  it('reclaims managed tables stranded below user text', () => {
    const managedTable = [
      '[[hooks]]',
      'event = "Stop"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10'
    ].join('\n')
    const orphan = `${START_MARKER}\n${managedTable}\n[user.table]\nv = 1\n${managedTable}\n`
    const { text } = removeManagedKimiHooks(orphan, isManaged)
    expect(text).toBe('[user.table]\nv = 1\n')
  })

  it('reports a stranded managed table as live so status cannot claim uninstalled', () => {
    const stranded = [
      '[user.table]',
      'v = 1',
      '',
      '[[hooks]]',
      'event = "PreToolUse"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      ''
    ].join('\n')
    expect(readManagedKimiHookEvents(stranded, isManaged)).toEqual(new Set(['PreToolUse']))
  })

  it('reinstalling over a stranded table does not double-register its event', () => {
    const stranded = [
      '[user.table]',
      'v = 1',
      '',
      '[[hooks]]',
      'event = "PreToolUse"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      ''
    ].join('\n')
    const reinstalled = applyManagedKimiHooks(stranded, COMMAND, isManaged)
    expect((reinstalled.match(/event = "PreToolUse"/g) ?? []).length).toBe(1)
    expect(reinstalled).toContain('[user.table]')
    expect(readManagedKimiHookEvents(reinstalled, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
  })

  it('stops an orphaned block at a second start marker', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    const duplicated = `${deleteEndMarker(installed)}\n${START_MARKER}\n[user.table]\nv = 1\n`
    const { text, changed } = removeManagedKimiHooks(duplicated, isManaged)
    expect(changed).toBe(true)
    expect(text).toContain('[user.table]')
    expect(text).not.toContain(START_MARKER)
    expect(text).not.toContain('agent-hooks/kimi-hook.sh')
  })

  it('removes both blocks when the markers are duplicated wholesale', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    const block = buildManagedKimiHooksBlock(COMMAND)
    const doubled = `${installed}\n${block}\n[user.table]\nv = 1\n`
    const { text, changed } = removeManagedKimiHooks(doubled, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe('default_model = "x"\n[user.table]\nv = 1\n')
  })

  it('leaves a stray start marker after a well-formed block bounded', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    const withStray = `${installed}${START_MARKER}\n[user.table]\nv = 1\n`
    const { text } = removeManagedKimiHooks(withStray, isManaged)
    expect(text).toBe('default_model = "x"\n[user.table]\nv = 1\n')
  })
})

describe('CRLF configs', () => {
  const userConfig = 'default_model = "kimi-k2.6"\r\n'

  it('writes the managed block with the file’s existing CRLF endings', () => {
    const installed = applyManagedKimiHooks(userConfig, COMMAND, isManaged)
    expect(installed).not.toMatch(/[^\r]\n/)
    expect(readManagedKimiHookEvents(installed, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
    expect(applyManagedKimiHooks(installed, COMMAND, isManaged)).toBe(installed)
    expect(removeManagedKimiHooks(installed, isManaged)).toEqual({
      text: userConfig,
      changed: true
    })
  })

  it('keeps CRLF user bytes after an orphaned block', () => {
    const installed = applyManagedKimiHooks(userConfig, COMMAND, isManaged)
    const orphaned = `${deleteEndMarker(installed)}\r\n[providers."mine"]\r\napi_key = "sk-secret"\r\n`
    const { text, changed } = removeManagedKimiHooks(orphaned, isManaged)
    expect(changed).toBe(true)
    expect(text).toContain('api_key = "sk-secret"')
    expect(text).not.toContain('agent-hooks/kimi-hook.sh')
    expect(text).not.toMatch(/[^\r]\n/)
  })
})
