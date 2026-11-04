import { readFileSync, statSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '../..')
const read = (file) => readFileSync(resolve(root, file), 'utf8')
// Any module specifier: the job installs no dependencies, so only relative files and node: built-ins load.
const MODULE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)['"]([^'"]+)['"]/g
const RELATIVE_INPUT = /(?:\bfrom\s*|\bimport\s*\(?\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g

// The path classifier runs before dependencies on a sparse checkout; every module it loads, and every
// file those modules read by relative URL, must be in that checkout or classification fails on CI.
it('sparse-checks-out every file the change classifier scripts load, and they need no package', () => {
  const job = parse(read('.github/workflows/pr.yml')).jobs.code_paths
  const checkout = job.steps.find((step) => step.with?.['sparse-checkout'])
  const sparse = checkout.with['sparse-checkout'].split('\n').filter(Boolean)
  const covered = (file) =>
    sparse.some((entry) =>
      entry.endsWith('/') ? `/${file}`.startsWith(entry) : `/${file}` === entry
    )
  const queue = job.steps.flatMap((step) =>
    [...(step.run ?? '').matchAll(/\b(?:node|bun)\s+([\w./-]+\.m?[jt]s)\b/g)].map(
      ([, script]) => script
    )
  )
  expect(queue.length).toBeGreaterThan(0)
  const seen = new Set()
  const bare = []
  for (const file of queue) {
    // Directory URLs (the repository root) name no file to load.
    if (seen.has(file) || !statSync(resolve(root, file), { throwIfNoEntry: false })?.isFile()) {
      continue
    }
    seen.add(file)
    for (const [, specifier] of read(file).matchAll(MODULE_SPECIFIER)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('node:')) {
        bare.push(`${file} imports ${specifier}`)
      }
    }
    for (const [, specifier] of read(file).matchAll(RELATIVE_INPUT)) {
      queue.push(posix.normalize(posix.join(posix.dirname(file), specifier)))
    }
  }
  expect([...seen].filter((file) => !covered(file))).toEqual([])
  expect(bare).toEqual([])
})
