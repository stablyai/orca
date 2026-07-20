import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transportState = vi.hoisted(() => ({
  commandFor: null as null | ((args: string[]) => { file: string; args: string[] })
}))

vi.mock('electron', () => ({
  app: { isPackaged: true }
}))

vi.mock('./herdr-cli-host-transport', () => ({
  HerdrCliHostTransport: class {
    constructor(options: { commandFor: typeof transportState.commandFor }) {
      transportState.commandFor = options.commandFor
    }
  },
  localHerdrCommand: (file: string) => (args: string[]) => ({ file, args })
}))

import type { Store } from '../persistence'
import type { IPtyProvider } from '../providers/types'
import * as binarySource from './herdr-binary-source'
import { createLocalHerdrPtyProvider } from './herdr-provider-factory'

describe('createLocalHerdrPtyProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    transportState.commandFor = null
  })

  afterEach(() => {
    Reflect.deleteProperty(process, 'resourcesPath')
  })

  it('does not resolve Herdr while Orca is using its native terminal backend', () => {
    const store = {
      getSettings: () => ({
        herdrBinarySource: { kind: 'custom', path: ' ' }
      })
    } as unknown as Store
    const fallback = {
      onData: () => () => {},
      onReplay: () => () => {},
      onExit: () => () => {}
    } as unknown as IPtyProvider

    expect(() => createLocalHerdrPtyProvider(fallback, store)).not.toThrow()
  })

  it('does not cache a managed executable until verification succeeds', () => {
    Object.defineProperty(process, 'resourcesPath', { value: '/resources', configurable: true })
    const store = {
      getSettings: () => ({ herdrBinarySource: { kind: 'managed' } })
    } as unknown as Store
    const fallback = {
      onData: () => () => {},
      onReplay: () => () => {},
      onExit: () => () => {}
    } as unknown as IPtyProvider
    const verify = vi
      .spyOn(binarySource, 'verifyManagedHerdrExecutable')
      .mockImplementationOnce(() => {
        throw new Error('verification failed')
      })
      .mockReturnValue({} as ReturnType<typeof binarySource.verifyManagedHerdrExecutable>)
    createLocalHerdrPtyProvider(fallback, store)

    expect(() => transportState.commandFor?.([])).toThrow('verification failed')
    expect(() => transportState.commandFor?.([])).not.toThrow()
    expect(verify).toHaveBeenCalledTimes(2)
  })
})
