import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BINARY_SOURCE_EXTENSIONS,
  assertNoCarriageReturnsInSource
} from './mobile-web-source-line-endings.mjs'

// Git-for-Windows defaults autocrlf=true; pin LF or same commit produces different bundle IDs and forces phone redownload.
const projectDir = resolve(import.meta.dirname, '../..')
const PAGE_SOURCE_TREES = ['mobile/src', 'mobile/app', 'mobile/web-entry']

function git(args) {
  return execFileSync('git', args, {
    cwd: projectDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
}

// Pass thousands of paths over stdin to avoid argv limit; check-attr -z returns NUL path/attr/value triples.
function attributes(name, paths) {
  const output = execFileSync('git', ['check-attr', '-z', name, '--stdin'], {
    cwd: projectDir,
    encoding: 'utf8',
    // Input is NUL-separated too; with -z, newline list becomes one invalid compound path.
    input: `${paths.join('\0')}\0`,
    maxBuffer: 256 * 1024 * 1024
  })
  const fields = output.split('\0')
  const found = new Map()
  for (let index = 0; index + 2 < fields.length; index += 3) {
    found.set(fields[index], fields[index + 2])
  }
  return found
}

function trackedPageSources() {
  return git(['ls-files', '-z', '--', ...PAGE_SOURCE_TREES])
    .split('\0')
    .filter(Boolean)
}

describe('the page source line-ending pin', () => {
  it('pins every tracked text source to LF and leaves the binaries alone', () => {
    const sources = trackedPageSources()
    expect(sources.length).toBeGreaterThan(0)

    const eol = attributes('eol', sources)
    const text = attributes('text', sources)
    const binary = sources.filter((path) =>
      BINARY_SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))
    )
    const unpinnedText = sources.filter((path) => !binary.includes(path) && eol.get(path) !== 'lf')
    const pinnedBinary = binary.filter((path) => text.get(path) !== 'unset')

    expect(unpinnedText, 'a CRLF checkout of these would fork the buildId').toEqual([])
    expect(pinnedBinary, 'a binary marked text would be rewritten on a Windows checkout').toEqual(
      []
    )
  })

  // Test future-path patterns as well as current files: cover intended tree without claiming neighbors.
  it.each([
    ['mobile/src/deep/nested/module.ts', 'eol', 'lf'],
    ['mobile/app/h/[hostId]/new-route.tsx', 'eol', 'lf'],
    ['mobile/web-entry/index.tsx', 'eol', 'lf'],
    ['mobile/src/assets/new.png', 'text', 'unset'],
    ['mobile/app/assets/new.woff2', 'text', 'unset'],
    ['mobile/scripts/build-something.mjs', 'eol', 'unspecified']
  ])('resolves %s to %s=%s', (path, name, expected) => {
    expect(attributes(name, [path]).get(path)).toBe(expected)
  })
})

describe('assertNoCarriageReturnsInSource', () => {
  it('accepts every committed page source tree', async () => {
    for (const tree of PAGE_SOURCE_TREES) {
      await expect(assertNoCarriageReturnsInSource(join(projectDir, tree))).resolves.toBeUndefined()
    }
  })

  it('rejects a CRLF source file, because CRLF changes every asset hash and the buildId', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-eol-'))
    try {
      await writeFile(join(scratch, 'route.tsx'), 'const a = 1\r\nconst b = 2\r\n', 'utf8')
      await expect(assertNoCarriageReturnsInSource(scratch)).rejects.toThrow(
        /CRLF in mobile web source/
      )
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
