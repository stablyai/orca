import { describe, expect, it } from 'vitest'
import { MOUNTED_OPERATION_MODULES } from './adapters/mounted-operation-modules'
import type { operationModuleLoader } from './operation-module-loader'

/**
 * Building a module's table must name product sources without reading them. A `modules.load` hoisted
 * out of `useHook` and into the table literal loads at registration time instead of at mount time,
 * which breaks two things far from the edit: a mutant anchored in a file two families share is then
 * applied more than once and `assertMutationApplied` reports the wrong count, and
 * `golden-header-digest.test.ts` builds its tables in a tree holding one family's files and throws
 * `Module not found` for the rest. Both read as an engine fault; neither names the adapter.
 */
function refusingLoader(): ReturnType<typeof operationModuleLoader> {
  return {
    load: (path: string) => {
      throw new Error(`loaded ${path} before a mount ran`)
    },
    mutationsApplied: () => 0
  }
}

describe('adapter mount tables', () => {
  it('reads no product source until a mount runs', () => {
    const eager = MOUNTED_OPERATION_MODULES.flatMap(({ source, mounts }) => {
      try {
        mounts(refusingLoader(), {})
        return []
      } catch (error) {
        return [`${source} ${error instanceof Error ? error.message : String(error)}`]
      }
    })
    expect(eager).toEqual([])
  })
})
