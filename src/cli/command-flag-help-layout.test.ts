import { describe, expect, it } from 'vitest'

import { findCommandSpec } from './args'
import { resolveFlagHelp } from './command-flag-help-layout'
import { formatCommandHelp } from './help'
import { formatLegacyCommandFlagHelp } from './legacy-command-flag-help'
import { COMMAND_SPECS } from './specs'

function resolveLegacy(flag: string, command: string) {
  return resolveFlagHelp(flag, undefined, formatLegacyCommandFlagHelp(flag, command))
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
  it('prefers spec flag help over the legacy string', () => {
    expect(resolveFlagHelp('type', '<kind> Message kind', '--type <kind>  legacy')).toEqual({
      label: '--type <kind>',
      description: 'Message kind'
    })
    expect(resolveFlagHelp('json', 'Emit JSON', '--json  legacy')).toEqual({
      label: '--json',
      description: 'Emit JSON'
    })
  })

  it('splits padded legacy entries on the alignment gap', () => {
    expect(resolveLegacy('json', 'terminal list')).toEqual({
      label: '--json',
      description: 'Emit machine-readable JSON'
    })
    expect(resolveLegacy('for', 'terminal wait')).toEqual({
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
      'worktree set',
      '--parent-worktree <selector>',
      'Parent worktree selector such as identity:<identity>, id:<repo-id>::<path>, branch:<branch>, issue:<number>, path:<path>, or active/current'
    ],
    [
      'workspace-status',
      'worktree set',
      '--workspace-status <id>',
      'Board status id (defaults: todo, in-progress, in-review, completed)'
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
  ])('splits the single-spaced legacy entry for --%s', (flag, command, label, description) => {
    expect(resolveLegacy(flag, command)).toEqual({ label, description })
  })

  it('keeps a bare legacy entry as a label with no description', () => {
    expect(resolveFlagHelp('mystery', undefined, '--mystery')).toEqual({ label: '--mystery' })
  })

  it('never leaves prose inside a legacy label', () => {
    for (const spec of COMMAND_SPECS) {
      if (spec.argumentMode === 'passthrough') {
        continue
      }
      const command = spec.path.join(' ')
      for (const flag of spec.allowedFlags) {
        const { label } = resolveLegacy(flag, command)
        expect(`${command} --${flag} => ${label}`).toMatch(
          / => --[A-Za-z0-9-]+( (<[^>]+>|\S*\|\S*))?$/
        )
      }
    }
  })
})

describe('formatCommandHelp option column', () => {
  it('aligns terminal list options on the widest flag label', () => {
    expect(optionLines('terminal list')).toEqual([
      '  --help                    Show this help message',
      '  --json                    Emit machine-readable JSON',
      '  --pairing-code',
      '  --environment',
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
