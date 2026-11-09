import { describe, expect, it } from 'vitest'
import { deriveRepoSlug, resolvePasteIntent } from './smart-source-paste-intent'

describe('resolvePasteIntent', () => {
  it('rejects oversized paste intents before any exact lookup', () => {
    expect(
      resolvePasteIntent(`https://github.com/acme/widgets/issues/12/${'x'.repeat(2048)}`)
    ).toBeNull()
  })
})

describe('deriveRepoSlug', () => {
  it('preserves an Enterprise upstream host', () => {
    expect(
      deriveRepoSlug({
        upstream: { owner: 'up', repo: 'stream', host: 'github.corp.example' }
      })
    ).toEqual({ owner: 'up', repo: 'stream', host: 'github.corp.example' })
  })
})
