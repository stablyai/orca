import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  makeDelegatedRelay,
  identity,
  preparation
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import type { RelayPtyRawEmissionSlice } from './relay-pty-raw-emission-checkpoint'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-raw-journal-'))
  directories.push(directory)
  const store = new RelayPtyOwnershipTransferFileStore(directory)
  const options = { enableDestinationOutputRetention: true }
  const relay = makeDelegatedRelay(store, options)
  relay.prepare(preparation)
  return { relay, store, reopen: () => makeDelegatedRelay(store, options) }
}
const span: RelayPtyRawEmissionSlice = {
  emissionId: '100:112',
  rawStartSu: 100,
  rawEndSu: 112,
  displayStartSu: 0,
  displayEndSu: 5,
  displayLengthSu: 5
}

it('persists raw/display distinction atomically with output and deduplicates after reopen', () => {
  const f = setup()
  f.relay.observeOutput(identity.terminalId, 'one🙂', '100:112', undefined, span)
  expect(f.store.loadAll()[0]).toMatchObject({
    sourceOutputEndSeq: 1,
    rawEmissionCheckpoint: { rawOriginSu: 100, rawEndSu: 112, journalThroughSeq: 1 }
  })
  const reopened = f.reopen()
  reopened.observeOutput(identity.terminalId, 'one🙂', '100:112', undefined, span)
  expect(f.store.loadAll()[0].history.frames).toEqual([{ seq: 1, data: 'one🙂' }])
  expect(() =>
    reopened.observeOutput(identity.terminalId, 'other', '100:112', undefined, span)
  ).toThrow('raw_emission_retry_changed')
})

it('persists partial slices and completes one raw interval exactly once after reopen', () => {
  const f = setup()
  f.relay.observeOutput(identity.terminalId, 'one', 'slice-1', undefined, {
    ...span,
    displayEndSu: 3
  })
  expect(f.store.loadAll()[0].rawEmissionCheckpoint).toMatchObject({
    rawEndSu: 100,
    journalThroughSeq: 0,
    pending: { displayEndSu: 3 }
  })
  f.reopen().observeOutput(identity.terminalId, '🙂', 'slice-2', undefined, {
    ...span,
    displayStartSu: 3
  })
  expect(f.store.loadAll()[0].rawEmissionCheckpoint).toMatchObject({
    rawEndSu: 112,
    journalThroughSeq: 2
  })
  expect(f.store.loadAll()[0].rawEmissionCheckpoint?.pending).toBeUndefined()
})

it('persists zero-display raw progress without inventing a frame', () => {
  const f = setup()
  const empty = { ...span, displayEndSu: 0, displayLengthSu: 0 }
  f.relay.observeOutput(identity.terminalId, '', '100:112', undefined, empty)
  f.reopen().observeOutput(identity.terminalId, '', '100:112', undefined, empty)
  expect(f.store.loadAll()[0]).toMatchObject({
    sourceOutputEndSeq: 0,
    history: { frames: [] },
    rawEmissionCheckpoint: { rawEndSu: 112, journalThroughSeq: 0 }
  })
})

it.each([false, true])(
  'rolls back failed save (written: %s) and retries the same frame and raw range',
  (written) => {
    const f = setup()
    const save = f.store.save.bind(f.store)
    vi.spyOn(f.store, 'save').mockImplementationOnce((record) => {
      if (written) {
        save(record)
      }
      throw new Error('uncertain save')
    })
    expect(() =>
      f.relay.observeOutput(identity.terminalId, 'one🙂', '100:112', undefined, span)
    ).toThrow('uncertain save')
    f.relay.observeOutput(identity.terminalId, 'one🙂', '100:112', undefined, span)
    expect(f.store.loadAll()[0]).toMatchObject({
      sourceOutputEndSeq: 1,
      rawEmissionCheckpoint: { rawEndSu: 112, journalThroughSeq: 1 }
    })
    expect(f.store.loadAll()[0].history.frames).toHaveLength(1)
  }
)

it('drops raw mapping after untyped output rather than claiming gap-free coverage', () => {
  const f = setup()
  f.relay.observeOutput(identity.terminalId, 'one🙂', '100:112', undefined, span)
  f.relay.observeOutput(identity.terminalId, 'unknown raw span')
  expect(f.store.loadAll()[0].rawEmissionCheckpoint).toBeUndefined()
})
