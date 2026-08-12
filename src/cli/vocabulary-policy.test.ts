import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './args'
import { COMMAND_SPECS } from './specs'
import { findVocabularyViolations } from './vocabulary-policy'

const spec = (path: string[], aliases?: string[][]): CommandSpec => ({
  path,
  aliases,
  summary: 's',
  usage: 'u',
  allowedFlags: []
})

describe('vocabulary policy (live tree)', () => {
  it('has no off-policy verbs that are not grandfathered or alias-bridged', () => {
    expect(findVocabularyViolations(COMMAND_SPECS)).toEqual([])
  })
})

describe('findVocabularyViolations (fixtures)', () => {
  it('flags a new deletion command using an off-policy verb', () => {
    const violations = findVocabularyViolations([spec(['gadget', 'delete'])])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ command: 'gadget delete', canonical: 'rm' })
  })

  it('passes a deletion command that bridges to the canonical verb via an alias', () => {
    const violations = findVocabularyViolations([spec(['gadget', 'delete'], [['gadget', 'rm']])])
    expect(violations).toEqual([])
  })

  it('rejects a canonical verb alias under an unrelated command prefix', () => {
    const violations = findVocabularyViolations([spec(['gadget', 'delete'], [['other', 'rm']])])
    expect(violations).toHaveLength(1)
  })

  it('rejects a canonical verb alias at a different command depth', () => {
    const violations = findVocabularyViolations([
      spec(['gadget', 'delete'], [['gadget', 'nested', 'rm']])
    ])
    expect(violations).toHaveLength(1)
  })

  it('passes the canonical deletion verb outright', () => {
    expect(findVocabularyViolations([spec(['gadget', 'rm'])])).toEqual([])
  })

  it('flags a new single-item read using get instead of show', () => {
    const violations = findVocabularyViolations([spec(['gadget', 'get'])])
    expect(violations[0]).toMatchObject({ verb: 'get', canonical: 'show' })
  })
})
