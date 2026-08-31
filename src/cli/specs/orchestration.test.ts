import { describe, expect, it } from 'vitest'

import type { CommandSpec } from '../command-spec'
import { formatCommandHelp } from '../help'
import { ORCHESTRATION_COMMAND_SPECS } from './orchestration'

function orchestrationSpec(command: string): CommandSpec {
  const entry = ORCHESTRATION_COMMAND_SPECS.find(
    (spec) => spec.path.join(' ') === `orchestration ${command}`
  )
  if (!entry) {
    throw new Error(`Missing orchestration ${command} spec`)
  }
  return entry
}

describe('orchestration command help', () => {
  it('defines spec-level help for every orchestration flag', () => {
    for (const spec of ORCHESTRATION_COMMAND_SPECS) {
      for (const flag of spec.allowedFlags) {
        const flagHelp = spec.flagHelp?.[flag]
        expect(flagHelp, `${spec.path.join(' ')} --${flag}`).toBeTruthy()
        expect(flagHelp, `${spec.path.join(' ')} --${flag}`).not.toMatch(/^<[^>]+>\s{2,}/)
      }
    }
  })

  it('aligns worker-start flag descriptions in one column', () => {
    const help = formatCommandHelp(orchestrationSpec('worker-start'))
    const optionLines = help.split('\n').filter((line) => line.startsWith('  --'))
    const descriptions = [
      'Worker placement; required with --terminal, where current means the coordinator worktree',
      'Prior Dispatch that this attempt replaces',
      'Existing agent terminal to reuse with its --worktree placement'
    ]

    const descriptionColumns = descriptions.map((description) => {
      const line = optionLines.find((candidate) => candidate.endsWith(description))
      expect(line, description).toBeTruthy()
      return line!.indexOf(description)
    })
    expect(new Set(descriptionColumns)).toEqual(new Set([descriptionColumns[0]]))
  })

  it('describes every task-create flag', () => {
    const spec = orchestrationSpec('task-create')
    const help = formatCommandHelp(spec)

    for (const flag of spec.allowedFlags) {
      expect(help, `expected --${flag} to include help text`).not.toMatch(
        new RegExp(`^  --${flag}$`, 'm')
      )
    }
  })

  it('prefers spec-level flag help over the global flag map', () => {
    const spec: CommandSpec = {
      path: ['example'],
      summary: 'Example command',
      usage: 'orca example --json',
      allowedFlags: ['json'],
      flagHelp: { json: 'Use the example-specific JSON representation' }
    }

    const help = formatCommandHelp(spec)

    expect(help).toMatch(/^  --json\s+Use the example-specific JSON representation$/m)
    expect(help).not.toContain('Emit machine-readable JSON')
  })
})
