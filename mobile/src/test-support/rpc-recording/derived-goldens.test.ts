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
  // Fails closed both ways: a golden the derivation dropped stays frozen with nothing certifying or
  // digesting it, and one it derives with no file on disk was never recorded.
  it('derives exactly the goldens on disk', () => {
    const derived = derivedGoldens(input.scenarios).map((golden) => golden.id)
    const onDisk = readdirSync(directory)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''))
    expect(derived.sort()).toEqual(onDisk.sort())
  })
})
