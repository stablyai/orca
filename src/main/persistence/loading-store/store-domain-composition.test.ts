/**
 * Store's API is assembled twice, and the two halves must agree: the
 * `interface Store extends …` declaration merge in store.ts gives the methods their
 * types, while STORE_DOMAIN_OPERATION_CLASSES is what actually copies them onto
 * Store.prototype at import time. A domain added to the merge but forgotten in the
 * class list typechecks, autocompletes, and then throws "is not a function" the
 * first time a user reaches the feature — the failure surfaces at runtime, in
 * production, with nothing in CI to catch it (domain unit tests drive the domain
 * object directly, never the Store).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { STORE_DOMAIN_OPERATION_CLASSES } from './store-domain-composition'

function declarationMergedDomainNames(): string[] {
  const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')
  const merge = /export interface Store\s+extends\s+([^{]+)\{\}/.exec(source)
  if (!merge?.[1]) {
    throw new Error('store.ts no longer declares `export interface Store extends …`')
  }
  return merge[1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

describe('store domain composition', () => {
  it('copies the prototype of every domain the Store type claims to extend', () => {
    const installed = new Set(STORE_DOMAIN_OPERATION_CLASSES.map((domain) => domain.name))
    const missing = declarationMergedDomainNames().filter((name) => !installed.has(name))
    expect(missing).toEqual([])
  })

  it('claims in the Store type every domain whose prototype it copies', () => {
    const merged = new Set(declarationMergedDomainNames())
    const untyped = STORE_DOMAIN_OPERATION_CLASSES.map((domain) => domain.name).filter(
      (name) => !merged.has(name)
    )
    expect(untyped).toEqual([])
  })
})
