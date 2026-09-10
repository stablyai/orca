import type { Dirent } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { walkSessionFiles } from './session-scanner-discovery'

function dirent(name: string, directory: boolean): Dirent {
  return { name, isDirectory: () => directory, isFile: () => !directory } as Dirent
}

/** Three matches: two siblings in one directory, and one in a later directory.
 *  The siblings are what pins the FILE-level early return — without them the
 *  directory-level one alone keeps the suite green. */
function tree(): Record<string, Dirent[]> {
  return {
    '/projects': [dirent('a', true), dirent('b', true)],
    '/projects/a': [
      dirent('other.jsonl', false),
      dirent('target.jsonl', false),
      dirent('extra-target.jsonl', false)
    ],
    '/projects/b': [dirent('target.jsonl', false)]
  }
}

describe('walkSessionFiles stopAfterFirstMatch', () => {
  const options = (readDirectory: (path: string) => Promise<Dirent[]>) => ({
    extensions: new Set(['.jsonl']),
    filePredicate: (path: string) => path.endsWith('target.jsonl'),
    readDirectory
  })

  it('stops walking once one file matches', async () => {
    const entries = tree()
    const readDirectory = vi.fn(async (path: string) => entries[path] ?? [])

    const files = await walkSessionFiles('/projects', 'claude', [], {
      ...options(readDirectory),
      stopAfterFirstMatch: true
    })

    expect(files).toEqual(['/projects/a/target.jsonl'])
    // The whole point: the rest of the tree is never read. On a home with
    // thousands of transcripts that traversal is most of the call.
    expect(readDirectory.mock.calls.map((call) => call[0])).toEqual(['/projects', '/projects/a'])
  })

  it('stops on the first match even when a sibling in the same directory matches', async () => {
    const entries = tree()
    const readDirectory = vi.fn(async (path: string) => entries[path] ?? [])

    const files = await walkSessionFiles('/projects/a', 'claude', [], {
      ...options(readDirectory),
      stopAfterFirstMatch: true
    })

    // Returning both would still resolve correctly, but only by luck of order.
    expect(files).toEqual(['/projects/a/target.jsonl'])
  })

  it('returns the same file the exhaustive walk would have returned first', async () => {
    const entries = tree()
    const readDirectory = vi.fn(async (path: string) => entries[path] ?? [])

    const all = await walkSessionFiles('/projects', 'claude', [], options(readDirectory))

    expect(all[0]).toBe('/projects/a/target.jsonl')
    expect(all).toHaveLength(3)
  })
})
