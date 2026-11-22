import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  browserBookmarkMutationSchema,
  browserBookmarkScopeKey,
  type BrowserBookmarkScope
} from '../../../shared/browser/bookmarks/browser-bookmarks'
import { BrowserBookmarkStore } from './browser-bookmark-store'

const DEFAULT: BrowserBookmarkScope = [null, 'default']
const ISOLATED: BrowserBookmarkScope = [null, 'isolated']
const REMOTE: BrowserBookmarkScope = ['runtime:remote', 'default']
const SSH: BrowserBookmarkScope = ['ssh:remote', 'isolated']
const defaultKey = browserBookmarkScopeKey(DEFAULT)

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-browser-bookmarks-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('browser bookmark persistence', () => {
  it('serializes concurrent saves and preserves profile ownership across edits and reloads', async () => {
    const store = new BrowserBookmarkStore(directory)
    expect(await store.list()).toEqual({})
    const add = browserBookmarkMutationSchema.parse({
      kind: 'add',
      title: 'Docs',
      url: 'HTTPS://EXAMPLE.COM:443/Docs/?mode=a#Intro'
    })
    expect(
      await Promise.all([
        store.mutate(DEFAULT, add),
        store.mutate(DEFAULT, add),
        store.mutate(ISOLATED, add),
        store.mutate(REMOTE, add),
        store.mutate(SSH, add)
      ])
    ).toEqual(['saved', 'duplicate', 'saved', 'saved', 'saved'])
    const original = (await store.list())[defaultKey][0]
    expect(original.url).toBe('https://example.com/Docs/?mode=a#Intro')

    const second = browserBookmarkMutationSchema.parse({
      kind: 'add',
      title: 'Another section',
      url: 'https://example.com/Docs/?mode=a#Another'
    })
    expect(await store.mutate(DEFAULT, second)).toBe('saved')
    expect(
      await store.mutate(DEFAULT, {
        kind: 'edit',
        id: original.id,
        title: 'Duplicate',
        url: 'https://example.com/Docs/?mode=a#Another'
      })
    ).toBe('duplicate')
    const edited = {
      id: original.id,
      title: 'Updated docs',
      url: 'https://example.com/Docs?mode=b#Intro'
    }
    expect(await store.mutate(DEFAULT, { kind: 'edit', ...edited })).toBe('saved')

    const restarted = new BrowserBookmarkStore(directory)
    expect((await restarted.list())[defaultKey]).toEqual([
      expect.objectContaining({ url: 'https://example.com/Docs/?mode=a#Another' }),
      edited
    ])
    expect(await restarted.mutate(DEFAULT, { kind: 'remove', id: original.id })).toBe('saved')
    await restarted.forgetLocalProfile('isolated')
    const final = await new BrowserBookmarkStore(directory).list()
    expect(final[defaultKey]).toHaveLength(1)
    expect(final[browserBookmarkScopeKey(ISOLATED)]).toBeUndefined()
    expect(final[browserBookmarkScopeKey(SSH)]).toBeUndefined()
    expect(final[browserBookmarkScopeKey(REMOTE)]).toEqual([
      expect.objectContaining({ title: 'Docs', url: 'https://example.com/Docs/?mode=a#Intro' })
    ])
  })

  it('drops malformed or duplicate rows while recovering valid records', async () => {
    const valid = {
      id: '0b339b8e-bf94-457a-889b-8f13911ebc93',
      url: 'https://example.com/docs',
      title: 'Docs'
    }
    writeFileSync(
      join(directory, 'browser-bookmarks.json'),
      JSON.stringify({
        [defaultKey]: [
          null,
          { ...valid, url: 'data:text/html,' },
          { ...valid, url: 'javascript:alert(1)' },
          { ...valid, url: 'https://person:password@example.com/docs' },
          valid,
          { ...valid, id: '403a3131-78df-4cf0-89cf-b0cfe219e465' },
          { ...valid, url: 'https://example.net' },
          { id: 'invalid', url: 'https://example.com' }
        ]
      })
    )
    expect((await new BrowserBookmarkStore(directory).list())[defaultKey]).toEqual([valid])
  })

  it('preserves the prior file when a collection cannot be decoded', async () => {
    const path = join(directory, 'browser-bookmarks.json')
    writeFileSync(path, '{"interrupted":')
    const store = new BrowserBookmarkStore(directory)
    await expect(
      store.mutate(DEFAULT, { kind: 'add', title: 'Docs', url: 'https://example.org/' })
    ).rejects.toThrow(SyntaxError)
    expect(readFileSync(path, 'utf-8')).toBe('{"interrupted":')
    await expect(new BrowserBookmarkStore(directory).list()).rejects.toThrow(SyntaxError)
  })
})
