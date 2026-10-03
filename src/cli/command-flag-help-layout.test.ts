import { describe, expect, it } from 'vitest'

import { findCommandSpec } from './args'
import type { CommandSpec } from './command-spec'
import { formatFlagHelpRows, resolveFlagHelp } from './command-flag-help-layout'
import { formatCommandFlagHelp, formatCommandHelp } from './help'
import { COMMAND_SPECS } from './specs'

function resolveShared(flag: string, command: string) {
  return resolveFlagHelp(flag, undefined, formatCommandFlagHelp(flag, command.split(' ')))
}

function optionLines(command: string): string[] {
  const spec = findCommandSpec(COMMAND_SPECS, command.split(' '))
  if (!spec) {
    throw new Error(`missing spec for ${command}`)
  }
  const lines = formatCommandHelp(spec).split('\n')
  const start = lines.indexOf('Options:')
  const end = lines.indexOf('', start + 1)
  return lines.slice(start + 1, end === -1 ? lines.length : end)
}

/** Column where the description starts, or -1 when the option line carries no description. */
function descriptionColumn(line: string): number {
  const match = /^ {2}\S(?:.*?\S)? {2,}(?=\S)/.exec(line)
  return match ? match[0].length : -1
}

describe('resolveFlagHelp', () => {
  it('prefers spec flag help over the shared string', () => {
    expect(resolveFlagHelp('type', '<kind> Message kind', '--type <kind>  shared')).toEqual({
      label: '--type <kind>',
      description: 'Message kind'
    })
    expect(resolveFlagHelp('json', 'Emit JSON', '--json  shared')).toEqual({
      label: '--json',
      description: 'Emit JSON'
    })
  })

  it('splits padded shared entries on the alignment gap', () => {
    expect(resolveShared('json', 'terminal list')).toEqual({
      label: '--json',
      description: 'Emit machine-readable JSON'
    })
    expect(resolveShared('for', 'terminal wait')).toEqual({
      label: '--for exit|tui-idle',
      description: 'Wait condition to satisfy'
    })
  })

  it.each([
    [
      'include-visual-layouts',
      'terminal list',
      '--include-visual-layouts',
      'Include tab and pane topology in JSON output'
    ],
    [
      'linear-issue',
      'worktree create',
      '--linear-issue <id|url|null>',
      'Linked Linear issue identifier or URL; null clears on set'
    ],
    [
      'parent-worktree',
      'worktree create',
      '--parent-worktree <selector>',
      'Parent selector such as identity:<identity>, active/current, id:<repo-id>::<path>, branch:<branch>, issue:<number>, path:<path>, folder:<id>, or worktree:<worktreeId>'
    ],
    [
      'source-context',
      'automations create',
      '--source-context <json|null>',
      'Explicit TaskSourceContext for automation task/provider data'
    ],
    [
      'setup',
      'worktree create',
      '--setup run|skip|inherit',
      'Setup policy for repo-defined setup hooks'
    ],
    ['workspace-mode', 'automations create', '--workspace-mode <mode>', 'existing or new-per-run']
  ])('splits the single-spaced shared entry for --%s', (flag, command, label, description) => {
    expect(resolveShared(flag, command)).toEqual({ label, description })
  })

  it('keeps a bare shared entry as a label with no description', () => {
    expect(resolveFlagHelp('mystery', undefined, '--mystery')).toEqual({ label: '--mystery' })
  })

  it('never leaves prose inside a shared-table label', () => {
    for (const spec of COMMAND_SPECS) {
      if (spec.argumentMode === 'passthrough') {
        continue
      }
      const command = spec.path.join(' ')
      for (const flag of spec.allowedFlags) {
        const { label } = resolveShared(flag, command)
        expect(`${command} --${flag} => ${label}`).toMatch(
          / => --[A-Za-z0-9-]+( (<[^>]+>|\S*\|\S*))?$/
        )
      }
    }
  })
})

describe('formatFlagHelpRows', () => {
  it('pads described rows to the widest described label and leaves bare rows alone', () => {
    expect(
      formatFlagHelpRows([
        { label: '--json', description: 'Emit JSON' },
        { label: '--a-much-longer-bare-flag' },
        { label: '--id <id>', description: 'Target id' }
      ])
    ).toEqual(['  --json     Emit JSON', '  --a-much-longer-bare-flag', '  --id <id>  Target id'])
  })
})

describe('formatCommandHelp option column', () => {
  it('uses spec-level help instead of the shared flag table', () => {
    const spec: CommandSpec = {
      path: ['example'],
      summary: 'Example command',
      usage: 'orca example --json',
      allowedFlags: ['json'],
      flagHelp: { json: 'Use the example-specific JSON representation' }
    }

    const help = formatCommandHelp(spec)

    expect(help).toMatch(/^ {2}--json +Use the example-specific JSON representation$/m)
    expect(help).not.toContain('Emit machine-readable JSON')
  })

  it('aligns terminal list options on the widest flag label', () => {
    // Remote selection rows are left out: their shared descriptions are being added separately.
    const rows = optionLines('terminal list').filter(
      (line) => !/^ {2}--(pairing-code|environment)\b/.test(line)
    )
    expect(rows).toEqual([
      '  --help                    Show this help message',
      '  --json                    Emit machine-readable JSON',
      '  --worktree <selector>     Worktree selector such as identity:<identity>, id:<repo-id>::<path>, name:<displayName>, branch:<branch>, issue:<number>, path:<path>, or active/current',
      '  --limit <n>               Maximum number of rows to return',
      '  --include-visual-layouts  Include tab and pane topology in JSON output'
    ])
  })

  it('aligns worktree create options on the widest flag label', () => {
    const lines = optionLines('worktree create')
    expect(lines).toContain(
      '  --setup run|skip|inherit      Setup policy for repo-defined setup hooks'
    )
    const columns = new Set(lines.map(descriptionColumn).filter((column) => column !== -1))
    expect(columns.size).toBe(1)
    // Widest label is `--parent-worktree <selector>` (28) + 2 padding + 2 indent.
    expect([...columns]).toEqual([32])
  })
})
