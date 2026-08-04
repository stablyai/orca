import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// `refresh()` is physically single-flight and a parked loader is never abandoned,
// so an unbounded loader pins its store for the process lifetime. The blocking-IO
// ratchet cannot catch this: a bare `fs/promises` read is async, not sync.
//
// Only direct calls in the loader body are visible here; a loader that delegates
// raw filesystem work to a helper still has to be reviewed by hand.

const MAIN_DIRECTORY = join(__dirname, '..')
const REFRESH_CALL = '.refresh('
const RAW_FS_CALL =
  /\b(?:readFile|readFileSync|existsSync|stat|statSync|lstat|lstatSync|realpath|realpathSync|readdir|readdirSync|access|accessSync|open|openSync)\s*\(/

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(entryPath)
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [entryPath] : []
  })
}

function refreshCallBodies(contents: string): string[] {
  const bodies: string[] = []
  let searchFrom = 0
  for (;;) {
    const callIndex = contents.indexOf(REFRESH_CALL, searchFrom)
    if (callIndex === -1) {
      return bodies
    }
    let depth = 0
    let cursor = callIndex + REFRESH_CALL.length - 1
    for (; cursor < contents.length; cursor++) {
      const character = contents[cursor]
      if (character === '(') {
        depth++
      } else if (character === ')') {
        depth--
        if (depth === 0) {
          break
        }
      }
    }
    bodies.push(contents.slice(callIndex, cursor))
    searchFrom = cursor
  }
}

describe('memory snapshot loader boundedness', () => {
  it('no snapshot loader reads the filesystem directly', () => {
    const owners = sourceFiles(MAIN_DIRECTORY)
      .map((path) => ({ path, contents: readFileSync(path, 'utf-8') }))
      .filter(({ contents }) => contents.includes('new MemorySnapshotStore'))

    // Guards the test: a rename would otherwise leave it asserting over nothing.
    expect(owners.length).toBeGreaterThan(0)

    const loaders = owners.flatMap(({ path, contents }) =>
      refreshCallBodies(contents).map((body) => ({ path, body }))
    )
    expect(loaders.length).toBeGreaterThan(0)

    const offenders = loaders
      .filter(({ body }) => RAW_FS_CALL.test(body))
      .map(({ path }) => relative(MAIN_DIRECTORY, path))

    expect(offenders).toEqual([])
  })
})
