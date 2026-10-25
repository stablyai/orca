import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { derivedGoldens } from './derived-goldens'
import { readScenarios } from './scenario-input'

const root = resolve(import.meta.dirname, '../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)
const directory =
  process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')

describe('derived goldens', () => {
  // Check both directions: missing derivations leave orphan files, and missing files leave unrecorded scenarios.
  it('derives exactly the goldens on disk', () => {
    const derived = derivedGoldens(input.scenarios).map((golden) => golden.id)
    const onDisk = readdirSync(directory)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''))
    expect(
      derived.sort(),
      'Record new goldens with `pnpm --dir mobile rpc:record`; delete ones the manifest no longer derives with `pnpm --dir mobile rpc:record --prune`'
    ).toEqual(onDisk.sort())
  })
})
