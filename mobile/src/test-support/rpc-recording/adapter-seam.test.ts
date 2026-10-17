import type * as RpcClientContextModule from '../../transport/rpc-client-react-context'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { MOUNTED_OPERATION_MODULES } from './adapters/mounted-operation-modules'
import { loadHostClientContext } from './host-client-context-exposure'
import { operationModuleLoader } from './operation-module-loader'
import { mountFixture } from './recorder-fixture-shape'
import { screenMount } from './mounted-screen-tree'
import type { RpcClientContextValue } from '../../transport/rpc-client-context-contract'

const root = resolve(import.meta.dirname, '../../../..')
const engine = resolve(import.meta.dirname)
const directory = join(engine, 'adapters')
/** The register is the seam's own index, not an adapter. */
const REGISTER = 'mounted-operation-modules.ts'
const sources = MOUNTED_OPERATION_MODULES.map((module) => module.source)

describe('the adapter directory', () => {
  // A module left out of the register mounts nothing, so its scenarios fail as unknown operations.
  it('registers every file in the adapter directory', () => {
    const present = readdirSync(directory).filter((file) => file !== REGISTER)
    expect(present.sort()).toEqual([...sources].sort())
  })

  it('mounts the public host-client context read by the product hook', () => {
    const modules = operationModuleLoader(root)
    const context = loadHostClientContext(modules)
    const { useRpcClientContext } = modules.load<typeof RpcClientContextModule>(
      'mobile/src/transport/rpc-client-react-context.ts'
    )
    const value = mountFixture<RpcClientContextValue>({ getClientId: () => 'scripted-client' })
    const observed: { value?: RpcClientContextValue } = {}
    function Harness(): null {
      observed.value = useRpcClientContext()
      return null
    }
    const screen = screenMount(
      () => createElement(context.Provider, { value }, createElement(Harness)),
      () => {}
    )
    try {
      screen.mount()
      expect(screen.crash()).toBeNull()
      expect(observed.value).toBe(value)
    } finally {
      screen.unmount()
    }
  })
})
