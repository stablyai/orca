import { describe, expect, it } from 'vitest'
import { SERVER_COMMAND_SPECS } from './server'
import { COMMAND_SPECS } from './index'
import { findCommandSpec, normalizeCommandPositionals, parseArgs } from '../args'

describe('server command specs', () => {
  it('registers server link and server add as distinct commands', () => {
    const paths = SERVER_COMMAND_SPECS.map((spec) => spec.path.join(' '))
    expect(paths).toEqual(['server link', 'server add'])
    expect(COMMAND_SPECS.some((spec) => spec.path.join(' ') === 'server link')).toBe(true)
    expect(COMMAND_SPECS.some((spec) => spec.path.join(' ') === 'server add')).toBe(true)
  })

  it('maps the server add positional onto the pairing-code flag', () => {
    const spec = findCommandSpec(COMMAND_SPECS, ['server', 'add'])
    expect(spec?.positionalArgs).toEqual(['pairing-code'])
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['orca://pair?code=secret', '--name', 'homelab'], [])
    )
    // Why: spec lookup is by command path, so drive normalize directly on the spec.
    const withSpec = normalizeCommandPositionals(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preceding expect(spec).toBeDefined() narrows for the reader; normalizeCommandPositionals needs the non-optional type.
      [{ ...(spec as NonNullable<typeof spec>) }],
      parseArgs(['server', 'add', 'orca://pair?code=secret', '--name', 'homelab'], [])
    )
    expect(parsed.flags.get('pairing-code')).toBeUndefined()
    expect(withSpec.flags.get('pairing-code')).toBe('orca://pair?code=secret')
  })

  it('declares the remote-selection and server flags for server link', () => {
    const spec = findCommandSpec(COMMAND_SPECS, ['server', 'link'])
    expect(spec?.allowedFlags).toContain('rotate')
    expect(spec?.allowedFlags).toContain('ttl')
    expect(spec?.allowedFlags).toContain('address')
    expect(spec?.allowedFlags).toContain('reach')
  })
})
