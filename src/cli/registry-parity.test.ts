import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './args'
import { HANDLER_COMMAND_KEYS } from './dispatch'
import { findRegistryParityGaps } from './registry-parity'
import { COMMAND_SPECS } from './specs'

describe('registry parity (live tree)', () => {
  const handlerKeys = [...HANDLER_COMMAND_KEYS]

  it('has a handler for every canonical spec path', () => {
    const { specsWithoutHandler } = findRegistryParityGaps(COMMAND_SPECS, handlerKeys)
    expect(specsWithoutHandler).toEqual([])
  })

  it('has a spec for every handler key', () => {
    const { handlersWithoutSpec } = findRegistryParityGaps(COMMAND_SPECS, handlerKeys)
    expect(handlersWithoutSpec).toEqual([])
  })
})

describe('findRegistryParityGaps (fixtures)', () => {
  const spec = (path: string[], aliases?: string[][]): CommandSpec => ({
    path,
    aliases,
    summary: 's',
    usage: 'u',
    allowedFlags: []
  })

  it('flags a spec with no handler', () => {
    const gaps = findRegistryParityGaps([spec(['foo', 'bar'])], [])
    expect(gaps.specsWithoutHandler).toEqual(['foo bar'])
  })

  it('flags a handler with no spec', () => {
    const gaps = findRegistryParityGaps([spec(['foo', 'bar'])], ['foo bar', 'ghost cmd'])
    expect(gaps.handlersWithoutSpec).toEqual(['ghost cmd'])
  })

  it('does not require a handler for an alias path', () => {
    const gaps = findRegistryParityGaps([spec(['foo', 'rm'], [['foo', 'remove']])], ['foo rm'])
    expect(gaps.specsWithoutHandler).toEqual([])
    expect(gaps.handlersWithoutSpec).toEqual([])
  })
})
