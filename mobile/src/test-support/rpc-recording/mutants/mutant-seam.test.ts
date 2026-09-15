import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RECORDER_DIRECTORY } from '../recorder-digest'
import { RECORDING_DRIVERS } from '../recording-drivers'

const root = resolve(import.meta.dirname, '../../../../..')
const recorder = join(root, RECORDER_DIRECTORY)
const mutants = join(root, RECORDER_DIRECTORY, 'mutants')
/** The one file allowed to name this directory: it names it in order to exclude it. */
const EXCLUDER = 'recorder-digest.ts'
/** Both spellings of the path, so a constant is no more usable than the literal. */
const NAMES = ['mutants', 'MUTANT_DIRECTORY']

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
}

function resolved(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier)
  return ['', '.ts', '.tsx', '/index.ts']
    .map((suffix) => base + suffix)
    .find((candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate))
}

function relative(file: string): string {
  return file.slice(recorder.length + 1)
}

/** A suite that records nothing: excluded below, since no driver has reason to reach it. */
function suite(file: string): boolean {
  return file.endsWith('.test.ts') && !RECORDING_DRIVERS.some((driver) => file.endsWith(driver))
}

/**
 * Every module a driver pulls in, transitively, by static import or dynamic `import()`. Type
 * positions come along, which is why the graph is an order larger than the recorder itself: a
 * `typeof import(...)` drags in product modules. Reaching too much only widens what may not appear.
 */
function reachable(entries: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const pending = [...entries]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:from|import\()\s*'(\.[^']*)'/g)) {
      const target = resolved(file, match[1]!)
      if (target) {
        pending.push(target)
      }
    }
  }
  return seen
}

/**
 * `recorderSha256` skips this directory, so nothing here is pinned by any golden. That is only
 * sound while no recording can reach it: a mutant table an adapter imported would change what the
 * recording loads while every header stayed still. Reachability is proved from the recording
 * drivers outward rather than from this directory inward, because the question is what a golden's
 * bytes can depend on. The name scan then covers the paths a module can be read by rather than
 * imported, under either spelling of the directory.
 */
describe('the mutant seam', () => {
  const outside = sources(recorder).filter((file) => !file.startsWith(`${mutants}${sep}`))

  it('is unreachable from every recording driver', () => {
    const graph = reachable(RECORDING_DRIVERS.map((driver) => join(recorder, driver)))
    const reached = graph
      .values()
      .filter((file) => file.startsWith(`${mutants}${sep}`))
      .map(relative)
      .toArray()
      .sort()
    expect(reached).toEqual([])
    // A walk that resolved nothing would pass by reaching nothing, so name what it missed: every
    // recording file is reachable today, and one that stops being reachable is an orphan.
    const missed = outside
      .filter((file) => !suite(file) && !graph.has(file))
      .map(relative)
      .sort()
    expect(missed).toEqual([])
    expect(sources(mutants).length).toBeGreaterThan(1)
  })

  // A test that does not record cannot change a recording; the drivers do record, so they are held
  // to the engine's rule — a driver that read the table would change what it records silently.
  // Both names, because `MUTANT_DIRECTORY` spells the same path without the literal.
  it('is named in no recording file but the digest that excludes it', () => {
    const naming = outside
      .filter(
        (file) =>
          !file.endsWith(EXCLUDER) &&
          !suite(file) &&
          NAMES.some((name) => readFileSync(file, 'utf8').includes(name))
      )
      .map(relative)
    expect(naming).toEqual([])
  })
})
