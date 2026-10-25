import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RECORDING_DRIVERS } from '../recording-drivers'

const root = resolve(import.meta.dirname, '../../../../..')
const recorder = join(root, 'mobile/src/test-support/rpc-recording')
const mutants = join(recorder, 'mutants')
/** Names the drivers for the record script and the suites that check them; no recording loads it. */
const OFF_RECORDING_PATH = ['recording-drivers.ts']

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
 * A mutant planted on the recording path would be recorded and replayed alike, so every golden
 * would compare clean while certifying the mutated code rather than the product. Reachability is
 * proved from the recording drivers outward rather than from this directory inward, because the
 * question is what a golden's bytes can depend on. The name scan then covers the paths a module can
 * be read by rather than imported.
 */
describe('the mutant seam', () => {
  const outside = sources(recorder).filter((file) => !file.startsWith(`${mutants}${sep}`))

  it('is unreachable from every recording driver', () => {
    const graph = reachable(RECORDING_DRIVERS.map((driver) => join(recorder, driver)))
    const reached = [...graph]
      .filter((file) => file.startsWith(`${mutants}${sep}`))
      .map(relative)
      .sort()
    expect(reached).toEqual([])
    // A walk that resolved nothing would pass by reaching nothing, so name what it missed: every
    // recording file is reachable today, and one that stops being reachable is an orphan.
    const missed = outside
      .filter((file) => !suite(file) && !graph.has(file))
      .filter((file) => !OFF_RECORDING_PATH.includes(relative(file)))
      .map(relative)
      .sort()
    expect(missed).toEqual([])
    expect(sources(mutants).length).toBeGreaterThan(1)
  })

  // A test that does not record cannot change a recording; the drivers do record, so they are held
  // to the engine's rule — a driver that read the table would change what it records silently.
  it('is named in no recording file', () => {
    const naming = outside
      .filter((file) => !suite(file) && readFileSync(file, 'utf8').includes('mutants'))
      .map(relative)
    expect(naming).toEqual([])
  })
})
