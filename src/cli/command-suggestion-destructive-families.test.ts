import { describe, expect, it } from 'vitest'
import {
  findCommandSpec,
  normalizeCommandPositionals,
  parseArgs,
  validateCommandAndFlags
} from './args'
import { specPaths, type CommandSpec } from './command-spec'
import { suggestCommands, unknownCommandData } from './command-suggestion'
import { COMMAND_SPECS } from './specs'

const blocked = [
  ['orchestration resume', 'orchestration reset'],
  ['orchestration rerun', 'orchestration reset'],
  ['orchestration repl', 'orchestration reset'],
  ['artifacts deset', 'artifacts delete'],
  ['emulator ball', 'emulator kill'],
  ['emulator showdown', 'emulator shutdown'],
  ['orchestration worker-showw', 'orchestration worker-stop'],
  ['orchestration worker-state', 'orchestration worker-stop'],
  ['orchestration worker-relay', 'orchestration worker-release'],
  ['orchestration worker-reuse', 'orchestration worker-release'],
  ['tab clues', 'tab close'],
  ['linear relation move', 'linear relation remove'],
  ['environment rollbook', 'environment rollback']
]

const recovery = [
  ['orchestration rese', 'orchestration reset'],
  ['orchestration rest', 'orchestration reset'],
  ['emulator kil', 'emulator kill'],
  ['emulator shutdow', 'emulator shutdown'],
  ['orchestration worker-stp', 'orchestration worker-stop'],
  ['orchestration worker-releasee', 'orchestration worker-release'],
  ['tab clos', 'tab close'],
  ['tab clone', 'tab close'],
  ['environment rollbac', 'environment rollback'],
  ['environment remov', 'environment rm'],
  ['artifacts delet', 'artifacts delete'],
  ['worktree remov', 'worktree remove'],
  ['worktree delet', 'worktree delete'],
  ['orchestration chek', 'orchestration check'],
  ['linear relation remov', 'linear relation remove'],
  ['linear label remov', 'linear label remove'],
  ['capture stp', 'capture stop'],
  ['clea', 'clear']
]

describe('live destructive command recovery', () => {
  it.each(blocked)('does not turn %s into %s', (input, destructive) => {
    const path = input.split(' ')
    const data = unknownCommandData(COMMAND_SPECS, path)
    expect(data.suggestions).not.toContain(destructive)
    expect(data.nextSteps.join(' ')).not.toContain(`orca ${destructive}`)
    const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(path))
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).toThrow('Unknown command')
  })

  it.each(recovery)('still recovers %s as %s', (input, expected) => {
    const data = unknownCommandData(COMMAND_SPECS, input.split(' '))
    expect(data.suggestions).toContain(expected)
    expect(data.nextSteps.join(' ')).toContain(`orca ${expected}`)
  })

  it('retains the complete legitimate environment removal ranking', () => {
    expect(suggestCommands(COMMAND_SPECS, ['environment', 'remov'])).toEqual([
      'environment recover',
      'environment rm'
    ])
  })

  it('keeps every declared alias accepted and normalized to its canonical command', () => {
    for (const spec of COMMAND_SPECS) {
      for (const path of specPaths(spec)) {
        expect(findCommandSpec(COMMAND_SPECS, path)).toBe(spec)
        const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(path))
        expect(parsed.commandPath).toEqual(spec.path)
      }
    }
  })
})

function destructiveSpec(path: string[], aliases?: string[][]): CommandSpec {
  return { path, aliases, destructive: true, summary: '', usage: '', allowedFlags: [] }
}

describe('declared destructive alias families', () => {
  const deletion = destructiveSpec(
    ['worktree', 'rm'],
    [
      ['worktree', 'remove'],
      ['worktree', 'delete']
    ]
  )
  const reset = destructiveSpec(['orchestration', 'reset'])

  it('does not let intent for reset unlock a deletion candidate', () => {
    const specs = [deletion, reset, destructiveSpec(['artifacts', 'delete'])]
    expect(suggestCommands(specs, ['artifacts', 'deset'])).toEqual([])
  })

  it('shares only declared equivalent verbs with another command', () => {
    const specs = [deletion, reset, destructiveSpec(['environment', 'rm'])]
    expect(suggestCommands(specs, ['environment', 'remov'])).toEqual(['environment rm'])
    expect(suggestCommands(specs, ['environment', 'rese'])).toEqual([])
  })

  it('merges overlapping declarations transitively regardless of registry order', () => {
    const specs = [
      destructiveSpec(['one', 'read'], [['one', 'redo']]),
      destructiveSpec(['two', 'redo'], [['two', 'undo']]),
      destructiveSpec(['three', 'undo'])
    ]
    expect(suggestCommands(specs, ['three', 'red'])).toEqual(['three undo'])
    expect(suggestCommands(specs.toReversed(), ['three', 'red'])).toEqual(['three undo'])
  })

  it('does not derive destructive equivalence from ordinary command aliases', () => {
    const specs: CommandSpec[] = [
      destructiveSpec(['state', 'undo']),
      {
        path: ['inspect', 'read'],
        aliases: [['inspect', 'undo']],
        summary: '',
        usage: '',
        allowedFlags: []
      }
    ]
    expect(suggestCommands(specs, ['state', 'red'])).toEqual([])
  })

  it('keeps ranking, deduplication, depth, and the three-result limit', () => {
    const specs = [
      destructiveSpec(['state', 'reset']),
      ...['rest', 'resee', 'reses', 'resets'].map((verb) => ({
        path: ['state', verb],
        summary: '',
        usage: '',
        allowedFlags: []
      })),
      { path: ['state', 'rest'], summary: '', usage: '', allowedFlags: [] },
      { ...destructiveSpec(['state', 'rese']), hidden: true }
    ]
    expect(suggestCommands(specs, ['state', 'rese'])).toEqual([
      'state resee',
      'state reses',
      'state reset'
    ])
    expect(suggestCommands(specs, ['state', 'rese', 'extra'])).toEqual([])
  })
})
