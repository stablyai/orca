import { describe, expect, it } from 'vitest'

import { buildHandlerRoutes, dispatch, type HandlerContext } from './dispatch'
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

describe('dispatch errors', () => {
  const ctx = {
    flags: new Map(),
    cwd: '/tmp',
    json: false
  } as unknown as HandlerContext

  it('reports an unknown command with the joined path', async () => {
    await expect(dispatch(['not', 'a', 'command'], ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Unknown command: not a command'
    })
  })
})
