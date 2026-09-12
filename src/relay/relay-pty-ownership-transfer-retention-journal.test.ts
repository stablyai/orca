import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  makeDelegatedRelay,
  preparation,
  request,
  context,
  identity
} from './relay-pty-ownership-transfer-delegation-test-fixture'

describe('retention journal compatibility and failure recovery', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-retention-journal-'))
    store = new RelayPtyOwnershipTransferFileStore(directory)
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))
  const restore = (store: RelayPtyOwnershipTransferFileStore) =>
    makeDelegatedRelay(store, {
      enableDestinationOutputRetention: true,
      replayBytes: 6
    })

  it.each([
    { version: 3 },
    { destinationOutputRetention: undefined },
    { destinationOutputRetention: false },
    { destinationDelegation: undefined },
    { phase: 'committed' },
    { reconnectRoute: { generation: 8, attachmentId: 'old-desktop' } },
    {
      acceptedControls: [{ controlId: 'old-control', serializedControl: '{}', outcome: 'applied' }]
    }
  ])('rejects contradictory retention record %# without modifying it', (patch) => {
    const adapter = restore(store)
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    const record = store.loadAll()[0]
    store.save({ ...record, ...patch } as typeof record)
    const before = store.loadAll()
    expect(() => restore(store)).toThrow('journal_invalid')
    expect(store.loadAll()).toEqual(before)
  })

  it('does not shrink protected history when reopened with a smaller capacity', () => {
    const adapter = restore(store)
    adapter.prepare(preparation)
    adapter.observeOutput(identity.terminalId, 'first')
    const before = store.loadAll()
    expect(() => makeDelegatedRelay(store, { replayBytes: 4 })).toThrow('journal_invalid')
    expect(store.loadAll()).toEqual(before)
  })

  it.each([false, true])(
    'recovers an output save failure without evicting unacknowledged history (written: %s)',
    (written) => {
      let fail = false
      const adapter = makeDelegatedRelay(
        {
          loadAll: () => store.loadAll(),
          remove: (id) => store.remove(id),
          save: (record) => {
            if (!fail || written) {
              store.save(record)
            }
            if (fail) {
              throw new Error('save failed')
            }
          }
        },
        { enableDestinationOutputRetention: true, replayBytes: 6 }
      )
      adapter.prepare(preparation)
      adapter.observeOutput(identity.terminalId, 'one', '0:3')
      fail = true
      expect(() => adapter.observeOutput(identity.terminalId, 'two', '3:6')).toThrow('save failed')
      expect(store.loadAll()[0].history.frames.map((frame) => frame.data)).toEqual(
        written ? ['one', 'two'] : ['one']
      )
      fail = false
      adapter.observeOutput(identity.terminalId, 'two', '3:6')
      expect(store.loadAll()[0].history.frames).toEqual([
        { seq: 1, data: 'one' },
        { seq: 2, data: 'two' }
      ])
      expect(() => restore(store).observeOutput(identity.terminalId, 'x')).toThrow(
        'output_capacity'
      )
    }
  )
})
