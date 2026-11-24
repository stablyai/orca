import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findPinViolations, PINNED_PROTECTED_COPY } from './protected-copy-keys.mjs'

const root = path.join(path.sep, 'repo')
const pin = PINNED_PROTECTED_COPY[0]
const generated = { keys: pin.keys, prefixes: [] }

describe('protected copy pins', () => {
  it('fails when a pinned file is missing instead of scanning it as empty', () => {
    const sources = new Map(pin.files.slice(1).map((file) => [path.join(root, file), '']))

    expect(findPinViolations(sources, new Set(pin.keys), generated, root)).toEqual([
      `pinned file ${pin.files[0]} not found; update its path in PINNED_PROTECTED_COPY`
    ])
  })
})
