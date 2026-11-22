import { describe, expect, it } from 'vitest'
import {
  applyManagedDshPatch,
  findManagedDshPatchRegion,
  removeManagedDshPatch
} from './dsh-home-patch'

const HOOKS_PATH = '/home/dev/.orca/agent-hooks/dsh-hooks.json'

function applyOrFail(text: string, hooksPath = HOOKS_PATH): string {
  const next = applyManagedDshPatch(text, hooksPath)
  if (next === null) {
    throw new Error('expected the patch file to be editable')
  }
  return next
}

const USER_ROWS = ['- id: llm-deepseek', '  config:', "    apiKeyEnv: 'MY_KEY'", ''].join('\n')

describe('applyManagedDshPatch', () => {
  it.each(['[{ id: llm-deepseek }]\n', '[\n  { id: a },\n  { id: b }\n]\n'])(
    'refuses to append after the non-empty flow sequence %j',
    (text) => {
      // YAML forbids appending block entries after a flow sequence.
      expect(applyManagedDshPatch(text, HOOKS_PATH)).toBeNull()
    }
  )
})

describe('removeManagedDshPatch', () => {
  it('leaves user rows alone and adds no [] when they remain', () => {
    const installed = applyOrFail(USER_ROWS)
    const { text } = removeManagedDshPatch(installed)
    expect(text.trimEnd()).toBe(USER_ROWS.trimEnd())
  })
})

describe('findManagedDshPatchRegion', () => {
  const ORPHAN_START = '# >>> orca-managed-dsh-hooks (managed by Orca; do not edit) >>>'

  it('fails closed on a truncated region rather than guessing its extent', () => {
    // Guessing a missing end marker could delete subsequent user rows.
    const truncated = `${ORPHAN_START}\n${USER_ROWS}`
    expect(findManagedDshPatchRegion(truncated)).toBeNull()
    expect(removeManagedDshPatch(truncated).changed).toBe(false)
  })

  it('never pairs an orphan start with a later block\u2019s end', () => {
    // An orphan start must not pair with a later block's end and swallow the intervening user rows.
    const truncated = `${ORPHAN_START}\n${USER_ROWS}`
    const installed = applyOrFail(truncated)
    expect(installed).toContain('apiKeyEnv')

    const region = findManagedDshPatchRegion(installed)
    expect(region).not.toBeNull()
    const covered = installed.split('\n').slice(region?.startLine ?? 0, (region?.endLine ?? 0) + 1)
    expect(covered.join('\n')).not.toContain('apiKeyEnv')

    expect(applyOrFail(installed)).toContain('apiKeyEnv')
    expect(removeManagedDshPatch(installed).text).toContain('apiKeyEnv')
  })
})
