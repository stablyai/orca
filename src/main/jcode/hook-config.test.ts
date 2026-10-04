import { describe, expect, it } from 'vitest'
import {
  applyJcodeManagedHooks,
  parseJcodeHooksTable,
  removeJcodeManagedHooks,
  tomlQuoteString
} from './hook-config'

const EVENTS = ['turn_end', 'session_start', 'session_end', 'post_tool'] as const
const MANAGED_COMMAND = '/Users/tester/.orca/agent-hooks/jcode-hook.sh'

describe('jcode hook-config', () => {
  it('appends a [hooks] table when the config has none', () => {
    const source = '[display]\nemoji = false\n'
    const result = applyJcodeManagedHooks(source, EVENTS, MANAGED_COMMAND, 'jcode-hook.sh')
    expect(result.userOwnedEvents).toEqual([])
    expect(result.content).toContain('[hooks]')
    for (const event of EVENTS) {
      expect(result.content).toContain(`${event} = ${tomlQuoteString(MANAGED_COMMAND)}`)
    }
    expect(result.content).toContain('[display]')
    expect(result.content).toContain('emoji = false')
  })

  it('merges into an existing [hooks] table and preserves unrelated tables', () => {
    const source = `[display]
emoji = false

[hooks]
turn_end = "~/bin/my-turn-notify"
`
    const result = applyJcodeManagedHooks(source, EVENTS, MANAGED_COMMAND, 'jcode-hook.sh')
    // Why: the user-owned turn_end is kept verbatim and reported partial.
    expect(result.userOwnedEvents).toEqual(['turn_end'])
    expect(result.content).toContain('turn_end = "~/bin/my-turn-notify"')
    for (const event of ['session_start', 'session_end', 'post_tool']) {
      expect(result.content).toContain(`${event} = ${tomlQuoteString(MANAGED_COMMAND)}`)
    }
    expect(result.content).toContain('[display]')
  })

  it('is idempotent for an already-managed table', () => {
    const source = `[hooks]
turn_end = ${tomlQuoteString(MANAGED_COMMAND)}
session_start = ${tomlQuoteString(MANAGED_COMMAND)}
session_end = ${tomlQuoteString(MANAGED_COMMAND)}
post_tool = ${tomlQuoteString(MANAGED_COMMAND)}
`
    const result = applyJcodeManagedHooks(source, EVENTS, MANAGED_COMMAND, 'jcode-hook.sh')
    expect(result.content).toBe(source)
    expect(result.userOwnedEvents).toEqual([])
  })

  it('parses scalar [hooks] values and rejects non-scalar tables', () => {
    expect(parseJcodeHooksTable('[hooks]\nturn_end = "x"\n')?.turn_end).toBe('x')
    expect(parseJcodeHooksTable('[hooks]\nturn_end = """\nmultiline\n"""\n')).toBeNull()
  })

  it('tolerates jcode-owned scalar non-string hook settings', () => {
    // Why: jcode seeds `pre_tool_timeout_ms = 5000` into its own [hooks] table;
    // it is config, not a command, so parsing must skip it instead of erroring.
    const table = parseJcodeHooksTable('[hooks]\npre_tool_timeout_ms = 5000\n')
    expect(table).toEqual({})
    const result = applyJcodeManagedHooks(
      '[hooks]\npre_tool_timeout_ms = 5000\n',
      EVENTS,
      MANAGED_COMMAND,
      'jcode-hook.sh'
    )
    expect(result.content).toContain('pre_tool_timeout_ms = 5000')
    for (const event of EVENTS) {
      expect(result.content).toContain(`${event} = ${tomlQuoteString(MANAGED_COMMAND)}`)
    }
  })

  it('removes only managed entries and reports change', () => {
    const source = `[hooks]
turn_end = ${tomlQuoteString(MANAGED_COMMAND)}
session_start = "~/bin/mine"
`
    const result = removeJcodeManagedHooks(source, 'jcode-hook.sh')
    expect(result.changed).toBe(true)
    expect(result.content).not.toContain(MANAGED_COMMAND)
    expect(result.content).toContain('session_start = "~/bin/mine"')
  })

  it('keeps every table declared after [hooks] when removing managed entries', () => {
    // Why: `remote` rebuilds the file from the lines it keeps, so an early exit at
    // the next table header silently truncated the rest of a user's config.
    const source = `[hooks]
turn_end = ${tomlQuoteString(MANAGED_COMMAND)}
pre_tool_timeout_ms = 5000

[terminal]
preferred = "ghostty"

[ui]
theme = "dark"
`
    const result = removeJcodeManagedHooks(source, 'jcode-hook.sh')
    expect(result.changed).toBe(true)
    expect(result.content).not.toContain(MANAGED_COMMAND)
    expect(result.content).toContain('pre_tool_timeout_ms = 5000')
    expect(result.content).toContain('[terminal]')
    expect(result.content).toContain('preferred = "ghostty"')
    expect(result.content).toContain('[ui]')
    expect(result.content).toContain('theme = "dark"')
  })

  it('does not touch a managed-looking command outside the [hooks] table', () => {
    const source = `[terminal]
spawn_hook = ${tomlQuoteString(MANAGED_COMMAND)}

[hooks]
turn_end = ${tomlQuoteString(MANAGED_COMMAND)}
`
    const result = removeJcodeManagedHooks(source, 'jcode-hook.sh')
    expect(result.content).toContain(`spawn_hook = ${tomlQuoteString(MANAGED_COMMAND)}`)
    expect(result.content).not.toContain(`turn_end = ${tomlQuoteString(MANAGED_COMMAND)}`)
  })

  it('never deletes a user hook whose comment merely mentions the managed script', () => {
    // Why: matching the raw line treated the comment as the value — real config loss.
    const source = `[hooks]
turn_end = "~/bin/mine" # replaces agent-hooks/jcode-hook.sh
`
    const removed = removeJcodeManagedHooks(source, 'jcode-hook.sh')
    expect(removed.changed).toBe(false)
    expect(removed.content).toContain('~/bin/mine')
    const applied = applyJcodeManagedHooks(source, EVENTS, MANAGED_COMMAND, 'jcode-hook.sh')
    expect(applied.userOwnedEvents).toContain('turn_end')
  })

  it('repoints a managed entry left behind by a copied home or a platform switch', () => {
    // Why: isManaged matches any agent-hooks/jcode-hook path, but getStatus demands
    // the exact script path — a stale entry stuck the install on `partial` forever
    // with no Orca action able to repair it.
    const stale = '/Users/old/.orca/agent-hooks/jcode-hook.sh'
    const source = `[hooks]\nturn_end = ${tomlQuoteString(stale)}\n`
    const result = applyJcodeManagedHooks(source, EVENTS, MANAGED_COMMAND, 'jcode-hook.sh')
    expect(result.userOwnedEvents).toEqual([])
    expect(result.content).toContain(`turn_end = ${tomlQuoteString(MANAGED_COMMAND)}`)
    expect(result.content).not.toContain(stale)
  })

  it('accepts a quoted hooks table and a commented scalar', () => {
    const source = `['hooks']\npre_tool_timeout_ms = 5000 # ms\n`
    expect(parseJcodeHooksTable(source)).toEqual({})
    const result = applyJcodeManagedHooks(source, EVENTS, MANAGED_COMMAND, 'jcode-hook.sh')
    // Why: a second [hooks] table makes jcode reject the whole config.
    expect(result.content.match(/^\[?'?hooks/gm)?.length).toBe(1)
    expect(result.content).toContain('pre_tool_timeout_ms = 5000 # ms')
  })

  it('keeps CRLF line endings when editing a Windows-owned config', () => {
    const source = '[hooks]\r\nturn_end = "~/bin/mine"\r\n'
    const result = applyJcodeManagedHooks(source, EVENTS, MANAGED_COMMAND, 'jcode-hook.sh')
    expect(result.content).toContain('\r\n')
    expect(result.content).not.toContain('\n[hooks]')
    // Why: preserved CRLF lines must not gain a second `\r` on every edit.
    expect(result.content).not.toContain('\r\r')
  })
})
