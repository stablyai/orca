import { describe, expect, it } from 'vitest'
import {
  applyManagedVibeHooks,
  buildManagedVibeHooksBlock,
  removeManagedVibeHooks,
  readManagedVibeHookTypes,
  VIBE_HOOK_TYPES
} from './hook-config-toml'

const COMMAND =
  "if [ -x '/home/u/.orca/agent-hooks/mistral-vibe-hook.sh' ]; then /bin/sh '/home/u/.orca/agent-hooks/mistral-vibe-hook.sh'; fi"
const isManaged = (command: string | undefined): boolean =>
  typeof command === 'string' && command.includes('agent-hooks/mistral-vibe-hook.sh')

const START_MARKER = '# >>> orca-managed-vibe-hooks (managed by Orca; do not edit) >>>'

/** Drops only the `# <<< ... <<<` line, the hand-edit that orphans the block. */
function deleteEndMarker(text: string): string {
  return text.replace(/\r?\n# <<< orca-managed-vibe-hooks <<<(?=\r?\n|$)/, '')
}

describe('vibe managed hooks TOML block', () => {
  it('installs every managed type with match on tool hooks, none on post_agent', () => {
    const block = buildManagedVibeHooksBlock(COMMAND)
    for (const type of VIBE_HOOK_TYPES) {
      expect(block).toContain(`type = "${type}"`)
    }
    // Tool hooks get match = "*"; post_agent does not (Vibe rejects match on post_agent).
    expect(block).toMatch(/\[\[hooks\]\][\s\S]*?type = "pre_tool"[\s\S]*?match = "\*"/)
    expect(block).toMatch(/\[\[hooks\]\][\s\S]*?type = "post_tool"[\s\S]*?match = "\*"/)
    const postAgentChunk = block.split('type = "post_agent"')[1]
    expect(postAgentChunk).not.toContain('match =')
    expect(
      readManagedVibeHookTypes(applyManagedVibeHooks('', COMMAND, isManaged), isManaged)
    ).toEqual(new Set(VIBE_HOOK_TYPES))
  })

  it('preserves existing user config above the managed block', () => {
    const userConfig = [
      'default_agent = "accept-edits"',
      '',
      '[[hooks]]',
      'name = "user-guard"',
      'type = "pre_tool"',
      'match = "bash"',
      'command = "uv run python /path/to/guard"',
      ''
    ].join('\n')

    const next = applyManagedVibeHooks(userConfig, COMMAND, isManaged)
    expect(next).toContain('default_agent = "accept-edits"')
    // The user's own hook survives untouched.
    expect(next).toContain('name = "user-guard"')
    expect(next).toContain('command = "uv run python /path/to/guard"')
    expect(readManagedVibeHookTypes(next, isManaged)).toEqual(new Set(VIBE_HOOK_TYPES))
  })

  it('is idempotent — reinstalling does not duplicate the block', () => {
    const once = applyManagedVibeHooks('default_agent = "x"\n', COMMAND, isManaged)
    const twice = applyManagedVibeHooks(once, COMMAND, isManaged)
    expect(twice).toBe(once)
    expect((twice.match(/orca-managed-vibe-hooks \(/g) ?? []).length).toBe(1)
  })

  it('removes the managed block and restores the user config', () => {
    const userConfig = 'default_agent = "accept-edits"\n'
    const installed = applyManagedVibeHooks(userConfig, COMMAND, isManaged)
    const { text, changed } = removeManagedVibeHooks(installed, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe(userConfig)
    expect(readManagedVibeHookTypes(text, isManaged).size).toBe(0)
  })

  it('reports no change when removing from a config without the managed block', () => {
    const { text, changed } = removeManagedVibeHooks('default_agent = "x"\n', isManaged)
    expect(changed).toBe(false)
    expect(text).toBe('default_agent = "x"\n')
  })

  it('is stable across repeated calls (no stateful global-regex lastIndex drift)', () => {
    const installed = applyManagedVibeHooks('default_agent = "x"\n', COMMAND, isManaged)
    expect(removeManagedVibeHooks(installed, isManaged).changed).toBe(true)
    expect(removeManagedVibeHooks(installed, isManaged).changed).toBe(true)
    expect(removeManagedVibeHooks('default_agent = "x"\n', isManaged).changed).toBe(false)
    expect(readManagedVibeHookTypes(installed, isManaged)).toEqual(new Set(VIBE_HOOK_TYPES))
    expect(readManagedVibeHookTypes(installed, isManaged)).toEqual(new Set(VIBE_HOOK_TYPES))
  })

  it('recovers when a hand-edit deletes only the trailing end marker', () => {
    const installed = applyManagedVibeHooks('default_agent = "x"\n', COMMAND, isManaged)
    const orphaned = deleteEndMarker(installed)
    expect(orphaned).not.toContain('<<<')
    // The orphaned (still-active) hook tables are still recognized...
    expect(readManagedVibeHookTypes(orphaned, isManaged)).toEqual(new Set(VIBE_HOOK_TYPES))
    // ...remove strips them...
    expect(removeManagedVibeHooks(orphaned, isManaged)).toEqual({
      text: 'default_agent = "x"\n',
      changed: true
    })
    // ...and reinstall converges to a single block instead of duplicating.
    const reinstalled = applyManagedVibeHooks(orphaned, COMMAND, isManaged)
    expect((reinstalled.match(/orca-managed-vibe-hooks \(/g) ?? []).length).toBe(1)
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
    'name = "my-own-hook"',
    'type = "post_tool"',
    'command = "node my-own-hook.mjs"'
  ].join('\n')

  function orphanedWithUserTail(): string {
    const installed = applyManagedVibeHooks('default_agent = "x"\n', COMMAND, isManaged)
    return `${deleteEndMarker(installed)}\n${USER_TAIL}\n`
  }

  it('keeps user tables appended after an orphaned block through remove', () => {
    const { text, changed } = removeManagedVibeHooks(orphanedWithUserTail(), isManaged)
    expect(changed).toBe(true)
    expect(text).toContain('api_key = "sk-secret"')
    expect(text).toContain('command = "node my-own-hook.mjs"')
    expect(text).toContain('default_agent = "x"')
    // The reclaimed managed tables and the stray marker are gone.
    expect(text).not.toContain(START_MARKER)
    expect(text).not.toContain('agent-hooks/mistral-vibe-hook.sh')
  })

  it('keeps user tables appended after an orphaned block through reinstall', () => {
    const reinstalled = applyManagedVibeHooks(orphanedWithUserTail(), COMMAND, isManaged)
    expect(reinstalled).toContain('api_key = "sk-secret"')
    expect(reinstalled).toContain('command = "node my-own-hook.mjs"')
    // Exactly one well-formed block, appended after the surviving user bytes.
    expect((reinstalled.match(/orca-managed-vibe-hooks \(/g) ?? []).length).toBe(1)
    expect(reinstalled.indexOf('sk-secret')).toBeLessThan(reinstalled.indexOf(START_MARKER))
    expect(readManagedVibeHookTypes(reinstalled, isManaged)).toEqual(new Set(VIBE_HOOK_TYPES))
    // And a second install is a no-op, so the recovery converges.
    expect(applyManagedVibeHooks(reinstalled, COMMAND, isManaged)).toBe(reinstalled)
  })

  it('reclaims a genuinely managed orphan table but stops at the first user line', () => {
    const orphan = [
      'default_agent = "x"',
      '',
      START_MARKER,
      '[[hooks]]',
      'type = "pre_tool"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      '[hand.written]',
      'value = "keep"',
      ''
    ].join('\n')
    const { text, changed } = removeManagedVibeHooks(orphan, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe('default_agent = "x"\n[hand.written]\nvalue = "keep"\n')
  })

  it('removes only the stray marker when an orphan owns no managed content', () => {
    const orphan = `default_agent = "x"\n\n${START_MARKER}\n[user.table]\nvalue = "keep"\n`
    const { text, changed } = removeManagedVibeHooks(orphan, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe('default_agent = "x"\n[user.table]\nvalue = "keep"\n')
  })

  it('does not treat a user [[hooks]] table as Orca-owned content', () => {
    const orphan = [
      START_MARKER,
      '[[hooks]]',
      'type = "post_tool"',
      'command = "node my-own-hook.mjs"',
      'timeout = 10',
      ''
    ].join('\n')
    const { text } = removeManagedVibeHooks(orphan, isManaged)
    expect(text).toContain('command = "node my-own-hook.mjs"')
    expect(text).not.toContain(START_MARKER)
  })

  // A user adding keys has customised Orca's hook, not authored their own: the
  // command path is what makes it fire. Leaving it would keep sending Orca their
  // events after uninstall, and reinstall would double-fire the type.
  it('owns a managed table the user added an extra key to', () => {
    const orphan = [
      START_MARKER,
      '[[hooks]]',
      'type = "pre_tool"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      'description = "mine now"',
      ''
    ].join('\n')
    expect(removeManagedVibeHooks(orphan, isManaged).text).toBe('')
  })

  it('owns a customised managed table sitting outside any marker', () => {
    const customised = [
      'default_agent = "x"',
      '',
      '[[hooks]]',
      'type = "pre_tool"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      'description = "mine now"',
      ''
    ].join('\n')
    const { text, changed } = removeManagedVibeHooks(customised, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe('default_agent = "x"\n')
    expect(readManagedVibeHookTypes(customised, isManaged)).toEqual(new Set(['pre_tool']))
  })

  it('round-trips a CRLF config verbatim through remove and reinstall', () => {
    const userConfig = 'default_agent = "x"\r\n\r\n[providers."mine"]\r\napi_key = "sk-secret"\r\n'
    const installed = applyManagedVibeHooks(userConfig, COMMAND, isManaged)
    expect(installed).toContain('\r\n')
    const { text, changed } = removeManagedVibeHooks(installed, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe(userConfig)
    // Reinstall detects CRLF again and writes the block with it.
    const reinstalled = applyManagedVibeHooks(userConfig, COMMAND, isManaged)
    expect(reinstalled).toBe(installed)
    expect((reinstalled.match(/\r\n/g) ?? []).length).toBeGreaterThan(0)
  })
})
