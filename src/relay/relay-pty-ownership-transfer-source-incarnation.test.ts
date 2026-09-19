import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  identity,
  makeDelegatedRelay,
  preparation,
  source
} from './relay-pty-ownership-transfer-delegation-test-fixture'

describe('host-owned delegated source incarnation', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-source-incarnation-'))
    store = new RelayPtyOwnershipTransferFileStore(directory)
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('continues journaling and restores fences after the desktop source route disappears', () => {
    let connected = true
    const setInputFenced = vi.fn()
    const options = {
      resolveSource: () => (connected ? source : null),
      resolveTerminalIncarnation: () => source.incarnationId,
      setInputFenced
    }
    const adapter = makeDelegatedRelay(store, options)
    adapter.prepare(preparation)
    adapter.observeOutput(source.terminalId, 'before')
    connected = false
    adapter.observeOutput(source.terminalId, 'after')
    expect(store.loadAll()[0].history.frames.map((frame) => frame.data)).toEqual([
      'before',
      'after'
    ])
    setInputFenced.mockClear()
    const restored = makeDelegatedRelay(store, options)
    expect(restored.restoreInputFences()).toBe(1)
    expect(setInputFenced).toHaveBeenCalledExactlyOnceWith(source.terminalId, true)
    restored.observeOutput(source.terminalId, 'restored')
    expect(store.loadAll()[0].history.frames.map((frame) => frame.data)).toEqual([
      'before',
      'after',
      'restored'
    ])
  })

  it.each([null, 'replacement-incarnation'])(
    'does not adopt an unverified or replaced PTY: %s',
    (incarnation) => {
      let current: string | null = source.incarnationId
      const setInputFenced = vi.fn()
      const adapter = makeDelegatedRelay(store, {
        resolveTerminalIncarnation: () => current,
        setInputFenced
      })
      adapter.prepare(preparation)
      const before = store.loadAll()
      current = incarnation
      setInputFenced.mockClear()
      adapter.observeOutput(source.terminalId, 'must not capture replacement')
      expect(adapter.restoreInputFences()).toBe(0)
      expect(setInputFenced).not.toHaveBeenCalled()
      expect(store.loadAll()).toEqual(before)
      expect(store.loadAll()[0]).not.toHaveProperty('exit')
    }
  )

  it('does not allow a host incarnation alone to prepare a source-owner transfer', () => {
    const adapter = makeDelegatedRelay(store, {
      resolveSource: () => null,
      resolveTerminalIncarnation: () => source.incarnationId
    })
    expect(() => adapter.prepare(preparation)).toThrow()
    expect(store.loadAll()).toEqual([])
  })

  it('retains source-owner matching for ordinary nondelegated transfers', () => {
    let connected = true
    const adapter = makeDelegatedRelay(store, {
      resolveSource: () => (connected ? source : null),
      resolveTerminalIncarnation: () => source.incarnationId
    })
    adapter.prepare({ ...preparation, destinationDelegation: undefined })
    adapter.observeOutput(source.terminalId, 'before')
    connected = false
    adapter.observeOutput(source.terminalId, 'after')
    expect(adapter.restoreInputFences()).toBe(0)
    expect(store.loadAll()[0].history.frames.map((frame) => frame.data)).toEqual(['before'])
  })

  it('does not capture output after an authoritative exact-incarnation exit', () => {
    const adapter = makeDelegatedRelay(store, {
      resolveTerminalIncarnation: () => source.incarnationId
    })
    adapter.prepare(preparation)
    adapter.observeExit(identity.terminalId, identity.incarnationId, 0)
    const before = store.loadAll()
    adapter.observeOutput(source.terminalId, 'late')
    expect(adapter.restoreInputFences()).toBe(0)
    expect(store.loadAll()).toEqual(before)
  })
})
