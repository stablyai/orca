import { describe, expect, it } from 'vitest'
import { findCommandSpec, parseArgs, validateCommandAndFlags } from '../arguments/args'
import { formatCommandHelp } from '../discovery/help'
import { COMMAND_SPECS } from './index'

function spec(path: string[]) {
  const found = findCommandSpec(COMMAND_SPECS, path)
  if (!found) {
    throw new Error(`no spec for ${path.join(' ')}`)
  }
  return found
}

describe('orca host add command spec', () => {
  it('declares host add with its registration flags', () => {
    const add = spec(['host', 'add'])
    expect(add.summary).toContain('Register an SSH host')
    expect(add.usage).toContain('--host <host>')
    for (const flag of [
      'host',
      'name',
      'port',
      'user',
      'key',
      'jump',
      'allow-remote-cli-control'
    ]) {
      expect(add.allowedFlags).toContain(flag)
    }
    expect(add.booleanFlags).toContain('allow-remote-cli-control')
    expect(add.notes?.some((note) => note.includes('never read or copied'))).toBe(true)
  })

  it('parses --allow-remote-cli-control as a switch and accepts the registration flags', () => {
    const parsed = parseArgs(
      ['host', 'add', '--host', 'box.example.org', '--user', 'dev', '--allow-remote-cli-control'],
      [['host', 'add']],
      COMMAND_SPECS
    )

    expect(parsed.flags.get('allow-remote-cli-control')).toBe(true)
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
  })

  it('rejects a flag the command does not offer', () => {
    const parsed = parseArgs(
      ['host', 'add', '--host', 'box.example.org', '--bogus', 'x'],
      [['host', 'add']],
      COMMAND_SPECS
    )

    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).toThrow(
      'Unknown flag --bogus for command: host add'
    )
  })

  it('describes the registration flags in help output', () => {
    const addHelp = formatCommandHelp(spec(['host', 'add']))
    expect(addHelp).toContain('--key <path>')
    expect(addHelp).toContain('--allow-remote-cli-control')
    expect(addHelp).toContain('--jump <proxyjump>')
  })
})
