import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { bundleDeclarativeFiles } from './build-plugin-declarative-runtime.mjs'

it('keeps the checked-in runtime, testing kit and test hooks in sync with their sources', async () => {
  const bundles = await bundleDeclarativeFiles()
  for (const { output, text } of bundles) {
    expect({ output, fresh: readFileSync(output, 'utf8') === text }).toEqual({
      output,
      fresh: true
    })
  }
  const runtime = bundles.find(({ output }) => output.endsWith('orca-runtime.mjs'))?.text ?? ''
  // A bare import would fail in the guest: it has no module resolver beyond the import map.
  expect(runtime).not.toMatch(/^\s*import\s/m)
  // The kit must share the panel's runtime instance, never carry its own copy.
  const testing = bundles.find(({ output }) => output.endsWith('orca-testing.mjs'))?.text ?? ''
  expect(testing).toContain('"./orca-runtime.mjs"')
}, 60_000)
