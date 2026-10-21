import { describe, expect, it } from 'vitest'
import {
  applyManagedDshPatch,
  findManagedDshPatchRegion,
  readManagedDshHooksConfigPath,
  removeManagedDshPatch
} from './dsh-home-patch'

const HOOKS_PATH = '/home/dev/.orca/agent-hooks/dsh-hooks.json'

/** applyManagedDshPatch returns null only for files it refuses to edit; these cases expect an edit. */
function applyOrFail(text: string, hooksPath = HOOKS_PATH): string {
  const next = applyManagedDshPatch(text, hooksPath)
  if (next === null) {
    throw new Error('expected the patch file to be editable')
  }
  return next
}

// The body DSH writes into a freshly initialized patch file.
const PRISTINE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  ''
].join('\n')

const USER_ROWS = ['- id: llm-deepseek', '  config:', "    apiKeyEnv: 'MY_KEY'", ''].join('\n')

describe('applyManagedDshPatch', () => {
  it('creates the managed block in an empty file', () => {
    const text = applyOrFail('')
    expect(readManagedDshHooksConfigPath(text)).toBe(HOOKS_PATH)
    expect(text).toContain("name: '@deepseek-ai/dsh-hooks-claude-code'")
    expect(text.endsWith('\n')).toBe(true)
  })

  it('replaces the empty flow sequence DSH ships, keeping its comments', () => {
    const text = applyOrFail(PRISTINE)
    // `- item` after `[]` is a YAML parse error, so the `[]` token has to go.
    expect(text).not.toMatch(/^\[]$/m)
    expect(text).toContain('# Your patch layer for this dsh profile')
    expect(readManagedDshHooksConfigPath(text)).toBe(HOOKS_PATH)
  })

  it('appends after user rows without touching them', () => {
    const text = applyOrFail(USER_ROWS)
    expect(text.startsWith(USER_ROWS.trimEnd())).toBe(true)
    expect(readManagedDshHooksConfigPath(text)).toBe(HOOKS_PATH)
  })

  it('rewrites its own block in place rather than stacking copies', () => {
    const once = applyOrFail(USER_ROWS, '/old/path.json')
    const twice = applyOrFail(once)
    expect(twice.match(/orca-managed-dsh-hooks \(managed by Orca/g)).toHaveLength(1)
    expect(readManagedDshHooksConfigPath(twice)).toBe(HOOKS_PATH)
    expect(twice).not.toContain('/old/path.json')
  })

  it('is idempotent', () => {
    const once = applyOrFail(PRISTINE)
    expect(applyOrFail(once)).toBe(once)
  })

  it('treats `[] # comment` as the empty document it is, keeping the comment', () => {
    // The exact-match check missed this and appended `- insert:` after the flow sequence.
    const text = '[] # keep empty\n'
    const next = applyOrFail(text)
    expect(next).not.toMatch(/^\s*\[]/m)
    expect(next).toContain('# keep empty')
    expect(readManagedDshHooksConfigPath(next)).toBe(HOOKS_PATH)
  })

  it.each([
    '- id: llm-deepseek\n  config: {}\n', // block sequence — editable
    '\n',
    '# only a comment\n'
  ])('still edits %j', (text) => {
    expect(applyManagedDshPatch(text, HOOKS_PATH)).not.toBeNull()
  })

  it.each(['[{ id: llm-deepseek }]\n', '[\n  { id: a },\n  { id: b }\n]\n'])(
    'refuses to append after the non-empty flow sequence %j',
    (text) => {
      // YAML forbids a block entry after a flow sequence: appending would leave DSH unable
      // to parse the user's own layer either, so there is no safe in-place edit.
      expect(applyManagedDshPatch(text, HOOKS_PATH)).toBeNull()
    }
  )

  it('quotes a path containing a single quote', () => {
    const awkward = "/home/o'brien/.orca/agent-hooks/dsh-hooks.json"
    expect(readManagedDshHooksConfigPath(applyOrFail('', awkward))).toBe(awkward)
  })
})

describe('removeManagedDshPatch', () => {
  it('restores the empty flow sequence when nothing else remains', () => {
    const installed = applyOrFail(PRISTINE)
    const { text, changed } = removeManagedDshPatch(installed)
    expect(changed).toBe(true)
    // Without this the file would come back as an unparseable empty document.
    expect(text.trimEnd().endsWith('[]')).toBe(true)
    expect(text).toContain('# Your patch layer for this dsh profile')
  })

  it('leaves user rows alone and adds no [] when they remain', () => {
    const installed = applyOrFail(USER_ROWS)
    const { text } = removeManagedDshPatch(installed)
    expect(text.trimEnd()).toBe(USER_ROWS.trimEnd())
  })

  it('reports no change when the file carries no managed block', () => {
    expect(removeManagedDshPatch(USER_ROWS)).toEqual({ text: USER_ROWS, changed: false })
  })
})

describe('findManagedDshPatchRegion', () => {
  const ORPHAN_START = '# >>> orca-managed-dsh-hooks (managed by Orca; do not edit) >>>'

  it('fails closed on a truncated region rather than guessing its extent', () => {
    // Splicing a guessed end marker would delete the user rows that follow.
    const truncated = `${ORPHAN_START}\n${USER_ROWS}`
    expect(findManagedDshPatchRegion(truncated)).toBeNull()
    expect(removeManagedDshPatch(truncated).changed).toBe(false)
  })

  it('never pairs an orphan start with a later block\u2019s end', () => {
    // The data-loss shape: an interrupted write leaves an orphan start above the user's
    // rows, and the next install appends a complete block below them. Pairing the orphan
    // with the new end marker would make the region cover the user's rows, so install
    // (rewrite) and remove (strip) would both delete them.
    const truncated = `${ORPHAN_START}\n${USER_ROWS}`
    const installed = applyOrFail(truncated)
    expect(installed).toContain('apiKeyEnv')

    const region = findManagedDshPatchRegion(installed)
    expect(region).not.toBeNull()
    const covered = installed.split('\n').slice(region?.startLine ?? 0, (region?.endLine ?? 0) + 1)
    expect(covered.join('\n')).not.toContain('apiKeyEnv')

    // Both mutating paths must leave the user's rows intact, twice over.
    expect(applyOrFail(installed)).toContain('apiKeyEnv')
    expect(removeManagedDshPatch(installed).text).toContain('apiKeyEnv')
  })
})
