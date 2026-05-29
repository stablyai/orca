import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function readCreatureNames(path) {
  const source = readFileSync(path, 'utf8')
  return Array.from(source.matchAll(/^  '([^']+)',?$/gm), (match) => match[1])
}

describe('marine creature corpus mirrors', () => {
  it('keeps the mobile mirror in parity with the shared corpus', () => {
    const sharedNames = readCreatureNames('src/shared/marine-creatures.ts')
    const mobileNames = readCreatureNames('mobile/src/constants/marine-creatures.ts')

    expect(mobileNames).toEqual(sharedNames)
  })
})
