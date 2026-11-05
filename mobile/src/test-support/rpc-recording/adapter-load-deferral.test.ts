import { describe, expect, it } from 'vitest'
import { MOUNTED_OPERATION_MODULES } from './adapters/mounted-operation-modules'
import type { operationModuleLoader } from './operation-module-loader'

// Defer product loads until hook mount; registration-time loads apply shared-file mutants repeatedly and obscure adapter failures.
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
