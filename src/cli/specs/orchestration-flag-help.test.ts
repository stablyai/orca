import { describe, expect, it } from 'vitest'

import { GLOBAL_FLAGS } from '../args'
import type { CommandSpec } from '../command-spec'
import { formatCommandHelp } from '../help'
import { ORCHESTRATION_COMMAND_SPECS } from './orchestration'

// Described once in the shared flag table so every command keeps one wording.
const SHARED_TABLE_FLAGS = new Set<string>([...GLOBAL_FLAGS, 'retry-request'])
// Still bare in the shared table; #24194 adds their shared descriptions.
const AWAITING_SHARED_DESCRIPTION = new Set(['pairing-code', 'environment', 'retry-request'])

function commandName(spec: CommandSpec): string {
  return spec.path.join(' ')
}

function optionRows(spec: CommandSpec): string[] {
  const lines = formatCommandHelp(spec).split('\n')
  const start = lines.indexOf('Options:')
  const end = lines.indexOf('', start + 1)
  return lines.slice(start + 1, end === -1 ? lines.length : end)
}

function optionRow(spec: CommandSpec, flag: string): string | undefined {
  return optionRows(spec).find((row) => new RegExp(`^ {2}--${flag}( |$)`).test(row))
}

describe('orchestration flag help', () => {
  it('describes every orchestration flag in its command spec', () => {
    const missing = ORCHESTRATION_COMMAND_SPECS.flatMap((spec) =>
      spec.allowedFlags
        .filter((flag) => !SHARED_TABLE_FLAGS.has(flag) && !spec.flagHelp?.[flag])
        .map((flag) => `${commandName(spec)} --${flag}`)
    )

    expect(missing).toEqual([])
  })

  it('leaves global flags and --retry-request to the shared flag table', () => {
    const duplicated = ORCHESTRATION_COMMAND_SPECS.flatMap((spec) =>
      Object.keys(spec.flagHelp ?? {})
        .filter((flag) => SHARED_TABLE_FLAGS.has(flag))
        .map((flag) => `${commandName(spec)} --${flag}`)
    )

    expect(duplicated).toEqual([])
  })

  it('writes each entry as an optional value placeholder followed by prose', () => {
    for (const spec of ORCHESTRATION_COMMAND_SPECS) {
      for (const [flag, help] of Object.entries(spec.flagHelp ?? {})) {
        expect(help, `${commandName(spec)} --${flag}`).toMatch(/^(<[^>]+> )?[^<\s]/)
      }
    }
  })

  it('renders a description on every orchestration option row', () => {
    for (const spec of ORCHESTRATION_COMMAND_SPECS) {
      for (const flag of spec.allowedFlags.filter(
        (name) => !AWAITING_SHARED_DESCRIPTION.has(name)
      )) {
        expect(optionRow(spec, flag), `${commandName(spec)} --${flag}`).toMatch(
          new RegExp(`^ {2}--${flag}(?: \\S+)? {2,}\\S`)
        )
      }
    }
  })

  it('starts every orchestration description in one column', () => {
    for (const spec of ORCHESTRATION_COMMAND_SPECS) {
      const columns = new Set(
        optionRows(spec)
          .map((row) => /^ {2}--\S+(?: \S+)? {2,}(?=\S)/.exec(row)?.[0].length)
          .filter((column) => column !== undefined)
      )
      expect(columns.size, commandName(spec)).toBe(1)
    }
  })

  it('renders worker-start options with spec-level descriptions', () => {
    const spec = ORCHESTRATION_COMMAND_SPECS.find(
      (entry) => commandName(entry) === 'orchestration worker-start'
    )
    if (!spec) {
      throw new Error('Missing orchestration worker-start spec')
    }

    expect(optionRow(spec, 'retry-of')).toMatch(
      /^ {2}--retry-of <dispatch_id> +Prior Dispatch this attempt replaces; needs --task$/
    )
    expect(optionRow(spec, 'terminal')).toMatch(
      /^ {2}--terminal <handle> +Existing agent terminal to reuse instead of launching one$/
    )
    expect(optionRow(spec, 'json')).toMatch(/^ {2}--json +Emit machine-readable JSON$/)
  })
})
