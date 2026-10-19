import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { testImportClosure } from './e2e-test-import-closure.mjs'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const MANAGED_SSH_SPEC = /^tests\/e2e\/ssh-orcad-.*\.spec\.ts$/

const allSpecs = readdirSync(join(projectDir, 'tests/e2e'), { encoding: 'utf8', recursive: true })
  .map((name) => `tests/e2e/${name.split(sep).join('/')}`)
  .filter((file) => file.endsWith('.spec.ts'))

/** Test files only managed-SSH specs import: nothing else runs when they change. */
function managedSshOnlyHarness() {
  const importers = new Map()
  for (const spec of allSpecs) {
    for (const file of testImportClosure(projectDir, [spec])) {
      if (file !== spec) {
        importers.set(file, [...(importers.get(file) ?? []), spec])
      }
    }
  }
  return [...importers]
    .filter(([, specs]) => specs.every((spec) => MANAGED_SSH_SPEC.test(spec)))
    .map(([file]) => file)
    .sort()
}

describe('managed-SSH harness route contract', () => {
  it('starts the managed-SSH lane for every harness file only its specs import', () => {
    const harness = managedSshOnlyHarness()
    expect(harness.length).toBeGreaterThan(5)
    const unrouted = harness.filter(
      (file) => !selectPrE2eSpecs([file]).some((spec) => MANAGED_SSH_SPEC.test(spec))
    )
    expect(unrouted).toEqual([])
  })
})
