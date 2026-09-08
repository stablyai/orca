import { describe, expect, it } from 'vitest'
import { create } from 'zustand'
import { createPersistenceStatusSlice, type PersistenceStatusSlice } from './persistence-status'

function createSliceStore() {
  return create<PersistenceStatusSlice>()((...a) => ({
    ...createPersistenceStatusSlice(
      ...(a as unknown as Parameters<typeof createPersistenceStatusSlice>)
    )
  }))
}

describe('persistence-status slice', () => {
  it('starts with no recorded status', () => {
    const store = createSliceStore()
    expect(store.getState().persistenceStatus).toEqual({})
  })

  it('records a status by kind', () => {
    const store = createSliceStore()

    store.getState().setPersistenceStatus('keybindings', 'pending')

    expect(store.getState().persistenceStatus.keybindings).toEqual({ status: 'pending' })
  })

  it('records lastError alongside an error status', () => {
    const store = createSliceStore()

    store.getState().setPersistenceStatus('keybindings', 'error', 'network down')

    expect(store.getState().persistenceStatus.keybindings).toEqual({
      status: 'error',
      lastError: 'network down'
    })
  })

  it('overwrites the prior entry for the same kind and drops a stale lastError on success', () => {
    const store = createSliceStore()
    store.getState().setPersistenceStatus('keybindings', 'error', 'network down')

    store.getState().setPersistenceStatus('keybindings', 'synced')

    expect(store.getState().persistenceStatus.keybindings).toEqual({ status: 'synced' })
  })

  it('tracks entries per kind independently', () => {
    const store = createSliceStore()

    store.getState().setPersistenceStatus('keybindings', 'synced')
    store.getState().setPersistenceStatus('uiLocal', 'error', 'boom')

    expect(store.getState().persistenceStatus).toEqual({
      keybindings: { status: 'synced' },
      uiLocal: { status: 'error', lastError: 'boom' }
    })
  })
})
