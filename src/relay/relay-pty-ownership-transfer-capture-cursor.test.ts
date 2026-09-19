import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  identity,
  source,
  preparation,
  makeDelegatedRelay
} from './relay-pty-ownership-transfer-delegation-test-fixture'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-capture-cursor-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
function setup() {
  const store = new RelayPtyOwnershipTransferFileStore(directory)
  const resolveSource = vi.fn(() => source)
  const hasPendingSourceOutput = vi.fn(() => false)
  const relay = makeDelegatedRelay(store, {
    enableDestinationOutputRetention: true,
    resolveSource,
    hasPendingSourceOutput
  })
  relay.prepare(preparation)
  return { relay, store, resolveSource, hasPendingSourceOutput }
}

it('reads the prepared durable cursor and retains the same evidence after reopen', () => {
  const { relay, store } = setup()
  expect(relay.inspectPreparedCaptureCursor(identity)).toBe(0)
  relay.observeOutput(identity.terminalId, 'one')
  expect(relay.inspectPreparedCaptureCursor(identity)).toBe(1)
  const reopened = makeDelegatedRelay(store, { enableDestinationOutputRetention: true })
  expect(reopened.inspectPreparedCaptureCursor(identity)).toBe(1)
})

it('does not expose queued observation retries as a settled journal boundary', () => {
  const fixture = setup()
  fixture.hasPendingSourceOutput.mockReturnValue(true)
  expect(fixture.relay.inspectPreparedCaptureCursor(identity)).toBeNull()
  fixture.hasPendingSourceOutput.mockReturnValue(false)
  expect(fixture.relay.inspectPreparedCaptureCursor(identity)).toBe(0)
})

it.each([
  { ownerLease: 'other' },
  { incarnationId: 'other' },
  { sourceOwnerGeneration: 9 },
  { destinationRuntimeId: 'other' }
])('refuses a changed transfer identity: %j', (patch) => {
  expect(setup().relay.inspectPreparedCaptureCursor({ ...identity, ...patch })).toBeNull()
})

it('requires the original owner to remain authoritative and refuses aborted transfers', () => {
  const fixture = setup()
  fixture.resolveSource.mockReturnValueOnce({ ...source, sourceOwnerGeneration: 9 })
  expect(fixture.relay.inspectPreparedCaptureCursor(identity)).toBeNull()
  fixture.relay.abort({ version: 1, ...identity })
  expect(fixture.relay.inspectPreparedCaptureCursor(identity)).toBeNull()
})

it('refuses uncertain preparation writes even when the record may have reached disk', () => {
  const store = new RelayPtyOwnershipTransferFileStore(directory)
  const save = store.save.bind(store)
  vi.spyOn(store, 'save').mockImplementation((record) => {
    save(record)
    throw new Error('uncertain write')
  })
  const relay = makeDelegatedRelay(store, { enableDestinationOutputRetention: true })
  expect(() => relay.prepare(preparation)).toThrow('uncertain write')
  expect(relay.inspectPreparedCaptureCursor(identity)).toBeNull()
})

it('does not claim capture readiness without ACK-aware output retention', () => {
  const relay = makeDelegatedRelay(new RelayPtyOwnershipTransferFileStore(directory))
  relay.prepare(preparation)
  expect(relay.inspectPreparedCaptureCursor(identity)).toBeNull()
})
