import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  context,
  identity,
  makeDelegatedRelay,
  preparation,
  request
} from './relay-pty-ownership-transfer-delegation-test-fixture'

describe('delegated destination execution evidence', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-destination-exit-'))
    store = new RelayPtyOwnershipTransferFileStore(directory)
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('uses host incarnation evidence independently of desktop ownership or destination binding', () => {
    const resolveTerminalIncarnation = vi.fn<() => string | null>(() => identity.incarnationId)
    const adapter = makeDelegatedRelay(store, { resolveTerminalIncarnation })
    adapter.prepare(preparation)
    expect(adapter.inspectDestination(request(), context())).toMatchObject({
      executionVerdict: 'live',
      boundToConnection: false
    })
    for (const incarnation of [null, 'different']) {
      resolveTerminalIncarnation.mockReturnValue(incarnation)
      const status = adapter.inspectDestination(request(), context())
      expect(status.executionVerdict).toBe('unverifiable')
      expect(status).not.toHaveProperty('exit')
    }
    resolveTerminalIncarnation.mockImplementation(() => {
      throw new Error('lookup unavailable')
    })
    expect(adapter.inspectDestination(request(), context()).executionVerdict).toBe('unverifiable')
    expect(
      makeDelegatedRelay(store).inspectDestination(request(), context()).executionVerdict
    ).toBe('unverifiable')
  })

  it('reports the exact durable exit after restart without granting a destination claim', () => {
    const adapter = makeDelegatedRelay(store)
    adapter.prepare(preparation)
    adapter.observeExit(identity.terminalId, 'wrong-incarnation', 1)
    expect(adapter.inspectDestination(request(), context())).not.toHaveProperty('exit')
    adapter.observeExit(identity.terminalId, identity.incarnationId, 17)
    const save = vi.spyOn(store, 'save')
    const status = makeDelegatedRelay(store).inspectDestination(request(), context())
    expect(status).toMatchObject({
      executionVerdict: 'exited',
      boundToConnection: false,
      exit: { verdict: 'exited', code: 17 }
    })
    expect(status.exit).toEqual(store.loadAll()[0].exit)
    expect(save).not.toHaveBeenCalled()
    expect(Object.isFrozen(status.exit)).toBe(true)
  })

  it.each(['before', 'after'] as const)(
    'withholds pending exit evidence after an uncertain %s-write failure',
    (when) => {
      let fail = false
      const adapter = makeDelegatedRelay({
        loadAll: () => store.loadAll(),
        remove: (id) => store.remove(id),
        save: (record) => {
          if (!fail || when === 'after') {
            store.save(record)
          }
          if (fail) {
            throw new Error('uncertain exit write')
          }
        }
      })
      adapter.prepare(preparation)
      fail = true
      expect(() => adapter.observeExit(identity.terminalId, identity.incarnationId, 17)).toThrow(
        'uncertain exit write'
      )
      expect(adapter.inspectDestination(request(), context())).toMatchObject({
        executionVerdict: 'unverifiable'
      })
      expect(adapter.inspectDestination(request(), context())).not.toHaveProperty('exit')
      expect(
        makeDelegatedRelay(store).inspectDestination(request(), context()).executionVerdict
      ).toBe(when === 'after' ? 'exited' : 'unverifiable')
      fail = false
      adapter.observeExit(identity.terminalId, identity.incarnationId, 99)
      expect(adapter.inspectDestination(request(), context())).toMatchObject({
        executionVerdict: 'exited',
        exit: { code: 17 }
      })
    }
  )
})
