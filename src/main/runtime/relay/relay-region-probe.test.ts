import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RELAY_REGIONS } from './relay-region-probe'

// Read as text, not imported: `cloud/` is a separate pnpm workspace on a different zod major that
// the desktop build never installs, so a TS import would not resolve here.
const CONTRACT_SOURCE = readFileSync(
  new URL('../../../../cloud/packages/relay-contract/src/relay-regions.ts', import.meta.url),
  'utf8'
)

const DECLARATION = /^export const RELAY_REGIONS = \[([^\]]+)\] as const(?: satisfies .+)?$/gm
const QUOTED_REGION = /^(['"])([^'"]+)\1$/

// Without this a commented-out declaration is matched instead of the live one. The contract file
// keeps no `//` inside a string literal, so block comments plus whole-line `//` cover it.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// Throws rather than asserting so the fixtures below can drive it with `toThrow`; an expect inside
// a helper only reports against the live contract, which is the one input that cannot go wrong.
function readContractRegions(source: string): string[] {
  const declarations = [...stripComments(source).matchAll(DECLARATION)]
  // Exactly one: zero means the shape moved, and a second live-looking one means this test
  // would be pinning against whichever came first.
  if (declarations.length !== 1) {
    throw new Error('relay-regions.ts must declare RELAY_REGIONS exactly once as an inline array')
  }

  const elements = declarations[0]![1]!.split(',').map((element) => element.trim())
  if (elements.at(-1) === '') {
    elements.pop() // trailing comma
  }
  if (elements.length === 0) {
    throw new Error('relay-regions.ts declares RELAY_REGIONS as an empty array')
  }
  return elements.map((element) => {
    const quoted = QUOTED_REGION.exec(element)
    // Every element must parse: silently skipping one would hide a contract region from the
    // comparison below and let the two lists diverge while this test stayed green.
    if (quoted === null) {
      throw new Error(`relay-regions.ts element is not a quoted string literal: ${element}`)
    }
    return quoted[2]!
  })
}

describe('RELAY_REGIONS', () => {
  it('matches the relay contract exactly, region for region and in order', () => {
    // A longer desktop list withholds the region hint fleet-wide (the catalog can never reach
    // RELAY_REGIONS.length); a shorter one caches a hint won against an incomplete catalog. Order
    // is pinned too because bestMeasurement breaks latency ties on the RELAY_REGIONS index.
    expect([...RELAY_REGIONS]).toEqual(readContractRegions(CONTRACT_SOURCE))
  })
})

describe('readContractRegions', () => {
  it('reads the live declaration, not a commented-out one above it', () => {
    const source = [
      '/* Previous region catalog:',
      "export const RELAY_REGIONS = ['us-central1', 'asia-east2'] as const",
      '*/',
      "export const RELAY_REGIONS = ['us-central1', 'asia-east2', 'europe-west1'] as const"
    ].join('\n')

    expect(readContractRegions(source)).toEqual(['us-central1', 'asia-east2', 'europe-west1'])
  })

  it('refuses a source with two live-looking declarations', () => {
    const source = [
      'namespace Legacy {',
      "export const RELAY_REGIONS = ['us-central1'] as const",
      '}',
      "export const RELAY_REGIONS = ['us-central1', 'asia-east2'] as const"
    ].join('\n')

    expect(() => readContractRegions(source)).toThrow(
      'relay-regions.ts must declare RELAY_REGIONS exactly once as an inline array'
    )
  })

  it('refuses an element that is not a quoted string literal', () => {
    const source = "export const RELAY_REGIONS = ['us-central1', LEGACY_REGION] as const"

    expect(() => readContractRegions(source)).toThrow(
      'relay-regions.ts element is not a quoted string literal: LEGACY_REGION'
    )
  })
})
