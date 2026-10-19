import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'
import {
  ORCAD_COMPILE_CACHE_DIRNAME,
  enableManagedOrcadCompileCache,
  orcadCompileCacheEnv
} from './orcad-compile-cache'

const managed = {
  [ORCAD_MANAGED_ACTIVATION_ROOT_ENV]: '/home/u/.orca-remote/.fence'
}

describe('managed orcad compile cache', () => {
  it('caches inside a managed slot, where slot GC removes it with the slot', () => {
    const enableCompileCache = vi.fn()
    enableManagedOrcadCompileCache('/home/u/.orca-remote/orcad-1+ab', managed, {
      enableCompileCache
    })
    expect(enableCompileCache).toHaveBeenCalledWith(
      join('/home/u/.orca-remote/orcad-1+ab', ORCAD_COMPILE_CACHE_DIRNAME)
    )
  })

  it('never writes into a slot no client manages, such as a packaged app', () => {
    const enableCompileCache = vi.fn()
    enableManagedOrcadCompileCache('/Applications/Orca.app/orcad', {}, { enableCompileCache })
    expect(enableCompileCache).not.toHaveBeenCalled()
  })

  it('starts as before on a runtime without the API or with an unwritable slot', () => {
    expect(() => enableManagedOrcadCompileCache('/slot', managed, {})).not.toThrow()
    const enableCompileCache = vi.fn(() => {
      throw new Error('EACCES')
    })
    expect(() =>
      enableManagedOrcadCompileCache('/slot', managed, { enableCompileCache })
    ).not.toThrow()
  })

  it('hands the preflight child the slot cache only when this process enabled one', () => {
    const enabled = { getCompileCacheDir: () => '/slot/x/v24' }
    expect(orcadCompileCacheEnv('/slot', enabled, managed)).toEqual({
      NODE_COMPILE_CACHE: join('/slot', ORCAD_COMPILE_CACHE_DIRNAME)
    })
    expect(orcadCompileCacheEnv('/slot', { getCompileCacheDir: () => undefined }, managed)).toEqual(
      {}
    )
    expect(orcadCompileCacheEnv('/slot', {}, managed)).toEqual({})
    // Regression: an unmanaged orcad's own NODE_COMPILE_CACHE stays where the operator put it.
    expect(orcadCompileCacheEnv('/slot', enabled, {})).toEqual({})
  })
})
