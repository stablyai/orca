import { describe, expect, it } from 'vitest'
import { applyManagedKimiHooks, removeManagedKimiHooks } from './kimi-hook-config-toml'

const COMMAND =
  "if [ -x '/home/u/.orca/agent-hooks/kimi-hook.sh' ]; then /bin/sh '/home/u/.orca/agent-hooks/kimi-hook.sh'; fi"
const isManaged = (command: string | undefined): boolean =>
  typeof command === 'string' && command.includes('agent-hooks/kimi-hook.sh')
const START_MARKER = '# >>> orca-managed-kimi-hooks (managed by Orca; do not edit) >>>'

/** Drops only the `# <<< ... <<<` line, the hand-edit that orphans the block. */
function deleteEndMarker(text: string): string {
  return text.replace(/\r?\n# <<< orca-managed-kimi-hooks <<<(?=\r?\n|$)/, '')
}

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
    expect(text).not.toContain(START_MARKER)
    expect(text).not.toContain('agent-hooks/kimi-hook.sh')
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

  // TOML gaps do not end tables; removing a partial run would orphan later keys.
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
})

describe('CRLF configs', () => {
  const userConfig = 'default_model = "kimi-k2.6"\r\n'

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
