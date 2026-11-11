import { describe, expect, it } from 'vitest'

import { buildHandlerRoutes } from './dispatch'
import type { HandlerGroup } from './handler-group-manifest'

describe('duplicate command keys', () => {
  const group = (name: string, keys: string[]): HandlerGroup => ({
    name,
    keys,
    load: async () => ({})
  })

  it('rejects the same key claimed by two groups', () => {
    expect(() =>
      buildHandlerRoutes([group('alpha', ['ship it']), group('beta', ['ship it'])])
    ).toThrow('Duplicate CLI handler registration for "ship it" (alpha and beta)')
  })

  it('rejects a key duplicated inside one group list', () => {
    expect(() => buildHandlerRoutes([group('alpha', ['ship it', 'ship it'])])).toThrow(
      'Duplicate CLI handler registration for "ship it"'
    )
  })
})
