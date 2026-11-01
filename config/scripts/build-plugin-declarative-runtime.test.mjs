import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  bundleDeclarativeRuntime,
  DECLARATIVE_RUNTIME_OUTPUT
} from './build-plugin-declarative-runtime.mjs'

it('keeps the checked-in guest orca module in sync with its TypeScript source', async () => {
  const bundled = await bundleDeclarativeRuntime()
  expect(readFileSync(DECLARATIVE_RUNTIME_OUTPUT, 'utf8')).toBe(bundled)
  // A bare import would fail in the guest: it has no module resolver beyond the import map.
  expect(bundled).not.toMatch(/^\s*import\s/m)
}, 30_000)
