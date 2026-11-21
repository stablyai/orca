import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { holdCodexRolloutForDeletion } from './codex-rollout-deletion-guard'
import { linkCodexSessionFile, linkCodexSessionFileAsync } from './codex-session-link'

const NAME = 'rollout-2026-11-01T10-00-00-00000001-0000-4000-8000-000000000000.jsonl'

let root: string

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function hasEntry(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

describe('Codex session links', () => {
  it('leaves no dangling link when the source was deleted after it was listed', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-link-'))
    const source = join(root, 'source', NAME)

    expect(linkCodexSessionFile(source, join(root, 'sync.jsonl'))).toBe(false)
    expect(
      await linkCodexSessionFileAsync(source, join(root, 'async.jsonl'), { hardlinkOnly: false })
    ).toBe('failed')
    expect([join(root, 'sync.jsonl'), join(root, 'async.jsonl')].filter(hasEntry)).toEqual([])
  })

  it('gives a rollout no new name while it is held for deletion', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-link-'))
    const source = join(root, NAME)
    writeFileSync(source, '{}\n')
    const release = await holdCodexRolloutForDeletion(`${source}.zst`)

    expect(linkCodexSessionFile(source, join(root, 'sync.jsonl'))).toBe(false)
    expect(
      await linkCodexSessionFileAsync(source, join(root, 'async.jsonl'), { hardlinkOnly: false })
    ).toBe('failed')
    release()
    expect(
      await linkCodexSessionFileAsync(source, join(root, 'after.jsonl'), { hardlinkOnly: false })
    ).toBe('linked')
    expect([join(root, 'sync.jsonl'), join(root, 'async.jsonl')].filter(hasEntry)).toEqual([])
  })

  it('waits for a link already under way before a hold takes effect', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-link-'))
    const source = join(root, NAME)
    writeFileSync(source, '{}\n')
    const linking = linkCodexSessionFileAsync(source, join(root, 'linked.jsonl'), {
      hardlinkOnly: false
    })
    const release = await holdCodexRolloutForDeletion(source)

    // The deleter lists names only now, so the new one must already be there to be seen.
    expect(hasEntry(join(root, 'linked.jsonl'))).toBe(true)
    release()
    expect(await linking).toBe('linked')
  })
})
