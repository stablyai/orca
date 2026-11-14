import { describe, expect, it } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import {
  applyJcodeManagedHooks,
  parseJcodeHooksTable,
  removeJcodeManagedHooks,
  tomlQuoteString
} from './hook-config'

const EVENTS = ['turn_end', 'session_start', 'session_end', 'post_tool'] as const
const MANAGED_COMMAND = '/Users/tester/.orca/agent-hooks/jcode-hook.sh'

describe('jcode hook-config', () => {
  it('keeps every table declared after [hooks] when removing managed entries', () => {
    // Remote editing rebuilds the file; stopping at the next header would truncate user tables.
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

  it('never deletes a user hook whose comment merely mentions the managed script', () => {
    // A managed-script mention in a trailing comment does not confer ownership.
    const source = `[hooks]
turn_end = "~/bin/mine" # replaces agent-hooks/jcode-hook.sh
`
    const removed = removeJcodeManagedHooks(source, 'jcode-hook.sh')
    expect(removed.changed).toBe(false)
    expect(removed.content).toContain('~/bin/mine')
    const applied = applyJcodeManagedHooks(source, EVENTS, MANAGED_COMMAND, 'jcode-hook.sh')
    expect(applied.userOwnedEvents).toContain('turn_end')
  })

  it.each([
    ['inline', '[hooks]\npre_tool = ["a.sh"] # gate\n', ['a.sh']],
    ['inline trailing comma', "[hooks]\npre_tool = [ 'a.sh', ]\n", ['a.sh']],
    [
      'multi-line without trailing comma',
      '[hooks]\r\npre_tool = [\r\n  "a.sh",\r\n  "b.sh"\r\n]\r\n',
      ['a.sh', 'b.sh']
    ],
    [
      'closing bracket after last element',
      '[hooks]\npre_tool = [\n  "a.sh", # c\n  "b.sh"]\n',
      ['a.sh', 'b.sh']
    ],
    ['empty', '[hooks]\npre_tool = [ # none yet\n]\n', []]
  ])('appends to and removes from a %s hook array', (_name, source, user) => {
    const applied = applyJcodeManagedHooks(source, ['pre_tool'], MANAGED_COMMAND, 'jcode-hook.sh')
    expect(applied.userOwnedEvents).toEqual([])
    expect(parseToml(applied.content).hooks).toEqual({ pre_tool: [...user, MANAGED_COMMAND] })
    expect(parseJcodeHooksTable(applied.content)?.pre_tool).toEqual([...user, MANAGED_COMMAND])
    expect(removeJcodeManagedHooks(applied.content, 'jcode-hook.sh').content).toBe(source)
  })

  it('repoints a stale managed array element in place and drops managed duplicates', () => {
    const stale = tomlQuoteString('/Users/old/.orca/agent-hooks/jcode-hook.cmd')
    const current = tomlQuoteString(MANAGED_COMMAND)
    const source = `[hooks]\npre_tool = ["a.sh", ${stale}, "b.sh", ${current}]\nturn_end = [${stale}, ${stale}]\n`
    const applied = applyJcodeManagedHooks(
      source,
      ['pre_tool', 'turn_end'],
      MANAGED_COMMAND,
      'jcode-hook.sh'
    )
    expect(parseToml(applied.content).hooks).toEqual({
      pre_tool: ['a.sh', MANAGED_COMMAND, 'b.sh'],
      turn_end: [MANAGED_COMMAND]
    })
  })
})
