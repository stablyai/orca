import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true }
}))

import type { Store } from '../persistence'
import type { IPtyProvider } from '../providers/types'
import { createLocalHerdrPtyProvider } from './herdr-provider-factory'

describe('createLocalHerdrPtyProvider', () => {
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
})
