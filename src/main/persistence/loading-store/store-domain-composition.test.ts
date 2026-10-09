// A domain in one list but not the other typechecks, then throws "is not a function" at runtime.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { STORE_DOMAIN_OPERATION_CLASSES } from './store-domain-composition'

function declarationMergedDomainNames(): string[] {
  const source = readFileSync(new URL('./store-domain-composition.ts', import.meta.url), 'utf8')
  const merge = /export type StoreDomainOperations =([^]*?)\n\n/.exec(source)
  if (!merge?.[1]) {
    throw new Error(
      'store-domain-composition.ts no longer declares `export type StoreDomainOperations`'
    )
  }
  return merge[1]
    .split('&')
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
