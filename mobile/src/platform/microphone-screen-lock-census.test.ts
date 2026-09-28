/**
 * Who may name the screen: one module, and nothing on the page.
 *
 * The screen a dictation holds awake is a property of the microphone, so the device module that
 * opens the mic takes it and gives it back. Everything above that — the composer's five states, the
 * pending-audio budget, where a transcript is routed — has no business naming it, and the page has
 * no way to: the verb it used to ask through is gone, along with the tag pools, the timeouts and
 * the foreground re-acquire that existed to keep the page's idea of the screen and the device's
 * agreeing.
 *
 * A census rather than a rule in a reviewer's head, because the seam grew back twice from exactly
 * the shape this forbids: a page that can ask for a wake tag acquires the bookkeeping to track what
 * it asked for. Existence, not shape — any import of the package, and any mention of the verb's
 * name at all, from any file but the one owner.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MOBILE_DIR = fileURLToPath(new URL('../../', import.meta.url))

/** The one module that may hold the screen: the device calls the microphone's capture makes. */
const SCREEN_LOCK_OWNER = 'src/platform/native-audio-device.ts'

/** This file names both things it forbids, so it reads every file but itself. */
const CENSUS = 'src/platform/microphone-screen-lock-census.test.ts'

const KEEP_AWAKE_PACKAGE = 'expo-keep-awake'

/** Built rather than written, so the census does not contain the word it bans. */
const RETIRED_VERB_WORD = `wake${'lock'}`

function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        found.push(relative(MOBILE_DIR, full))
      }
    }
  }
  for (const root of ['src', 'app']) {
    walk(join(MOBILE_DIR, root))
  }
  return found.sort()
}

/** The line, not just the file: a census that answers "somewhere in 1,400 files" is one a reader
 *  has to re-run by hand before they can act on it. */
function hits(match: (line: string) => boolean, skip: readonly string[]): string[] {
  const found: string[] = []
  for (const file of sourceFiles()) {
    if (skip.includes(file)) {
      continue
    }
    const lines = readFileSync(join(MOBILE_DIR, file), 'utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      if (match(line)) {
        found.push(`${file}:${index + 1}: ${line.trim()}`)
      }
    }
  }
  return found
}

/** An import of the package, which is a module that can hold the screen. A test's `vi.mock` of it
 *  is not one: the mock exists because the graph reaches the owner, which is the rule holding. */
const importsKeepAwake = (line: string): boolean =>
  line.includes(`from '${KEEP_AWAKE_PACKAGE}'`) || line.includes(`require('${KEEP_AWAKE_PACKAGE}')`)

const namesRetiredVerb = (line: string): boolean =>
  line.toLowerCase().includes(RETIRED_VERB_WORD.toLowerCase())

describe('the one module that may hold the screen awake', () => {
  it('is the only one that imports the keep-awake package', () => {
    expect(hits(importsKeepAwake, [SCREEN_LOCK_OWNER, CENSUS])).toEqual([])
  })

  it('does import it, so the absence above is the rule holding and not the match missing', () => {
    // The presence precondition every absence needs: the matcher finds the one file that should
    // match, so a typo in the package name fails here rather than passing everywhere.
    expect(hits(importsKeepAwake, [CENSUS]).map((hit) => hit.split(':')[0])).toEqual([
      SCREEN_LOCK_OWNER
    ])
  })

  it('leaves no page-facing name for the screen anywhere in the app', () => {
    // The retired verb, in any casing: a grant row, a schema, a server, a tag, a mock or a comment
    // pointing at a seam that no longer exists.
    expect(hits(namesRetiredVerb, [CENSUS])).toEqual([])
  })

  it('reads a tree big enough for those absences to mean something', () => {
    // A walk that found nothing would pass all three rules above by having nothing to judge.
    expect(sourceFiles().length).toBeGreaterThan(900)
    expect(sourceFiles()).toContain(SCREEN_LOCK_OWNER)
  })
})
