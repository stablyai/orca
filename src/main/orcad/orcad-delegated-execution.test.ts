import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PtyOwnershipTransferDestinationAdapter } from '../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { PtyOwnershipTransferDestinationFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

let directory: string
const claim = { generation: 1, claimId: 'claim-1' }
const next = { generation: 2, claimId: 'claim-2' }
const receipt = {
  bridgeId: identity.bridgeId,
  receiptId: 'commit',
  acceptedSourceEndSeq: 0,
  committedAt: '2026-09-06T00:00:00.000Z'
}
const exit = {
  verdict: 'exited',
  eventId: 'exit-1',
  code: 17,
  observedAt: '2026-09-06T00:01:00.000Z'
}
const status = (patch: Record<string, unknown> = {}) => ({
  ...identity,
  version: 1,
  phase: 'committed',
  receipt,
  destinationClaim: claim,
  boundToConnection: true,
  executionVerdict: 'live',
  sourceOutputEndSeq: 0,
  ...patch
})
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-delegated-execution-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function setup(
  phase: 'prepared' | 'committed' | 'published' = 'committed',
  bind = true,
  surfaceBinding: PtyOwnershipTransferSurfaceBinding = preparation.surfacePublication.surfaceBinding
) {
  const store = new PtyOwnershipTransferDestinationFileStore({ directory })
  const publishOutput = vi.fn()
  const adapter = new PtyOwnershipTransferDestinationAdapter({
    store,
    publishDurably: (request) => request.publicationReceipt,
    publishPostCommitOutput: publishOutput
  })
  adapter.prepare({
    ...identity,
    version: 1,
    phase: 'prepared',
    sourceOutputEndSeq: 0,
    replayStartSeq: 1,
    surfacePublication: { version: 1, surfaceBinding }
  })
  if (bind) {
    adapter.bindSurface(surfaceBinding)
  }
  if (phase !== 'prepared') {
    adapter.commit(receipt)
  }
  if (phase === 'published') {
    adapter.publish()
  }
  return { adapter, store, publishOutput }
}

it.each(['prepared', 'committed', 'published'] as const)(
  'binds an exact local %s surface without asserting liveness',
  (phase) => {
    const { adapter } = setup(phase)
    expect(adapter.bindDelegatedExecution(claim)).toMatchObject({
      phase,
      executionVerdict: 'unverifiable'
    })
    expect(adapter.bindDelegatedExecution(claim)).toMatchObject({
      phase,
      executionVerdict: 'unverifiable'
    })
    expect(() => adapter.reserveExecutionAttachment('legacy')).toThrow()
  }
)

it('requires a bound surface and refuses aborted destinations', () => {
  const { adapter } = setup('prepared', false)
  expect(() => adapter.bindDelegatedExecution(claim)).toThrow()
  adapter.bindSurface(preparation.surfacePublication.surfaceBinding)
  adapter.abort()
  expect(() => adapter.bindDelegatedExecution(claim)).toThrow()
})

it('refuses a valid SSH-owned surface at the host-local delegated destination', () => {
  const { adapter } = setup('committed', true, {
    ...preparation.surfacePublication.surfaceBinding,
    executionHostId: 'ssh:other-host',
    ptyId: 'ssh:other-host@@pty-1'
  })
  expect(() => adapter.bindDelegatedExecution(claim)).toThrow()
})

it.each([false, true])('refuses an existing legacy attachment route (attached=%s)', (attached) => {
  const { adapter } = setup()
  const reservation = adapter.reserveExecutionAttachment('legacy')
  if (attached) {
    adapter.attachExecution(
      {
        ...identity,
        version: 1,
        phase: 'committed',
        attachmentId: 'legacy',
        executionVerdict: 'live'
      },
      reservation
    )
  }
  const before = adapter.snapshot()
  expect(() => adapter.bindDelegatedExecution(claim)).toThrow()
  expect(adapter.snapshot()).toEqual(before)
})

it('requires monotonic claims and refuses same-generation competing identities', () => {
  const { adapter } = setup()
  adapter.bindDelegatedExecution(claim)
  expect(() => adapter.bindDelegatedExecution({ generation: 1, claimId: 'foreign' })).toThrow()
  adapter.bindDelegatedExecution(next)
  expect(() => adapter.bindDelegatedExecution(claim)).toThrow()
  expect(() => adapter.acceptDelegatedExecutionStatus(status())).toThrow()
  expect(adapter.acceptDelegatedExecutionStatus(status({ destinationClaim: next }))).toMatchObject({
    executionVerdict: 'live'
  })
})

it.each([null, {}, { generation: 0, claimId: 'zero' }, { generation: 1, claimId: '' }])(
  'rejects malformed claims: %j',
  (invalid) => {
    const { adapter } = setup()
    expect(() => adapter.bindDelegatedExecution(invalid)).toThrow()
    expect(adapter.snapshot().executionVerdict).toBe('unverifiable')
  }
)

it.each([
  { terminalId: 'other' },
  { incarnationId: 'other' },
  { bridgeId: 'other' },
  { destinationRuntimeId: 'other' },
  { ownerLease: 'other' },
  { sourceOwnerGeneration: 2 },
  { receipt: { ...receipt, receiptId: 'foreign' } },
  { receipt: { ...receipt, committedAt: '2026-09-06T01:00:00.000Z' } },
  { destinationClaim: { generation: 1, claimId: 'foreign' } },
  { destinationClaim: next },
  { boundToConnection: false },
  { phase: 'prepared', receipt: undefined },
  { version: 2 },
  { executionVerdict: 'dead' }
])('rejects mismatched or malformed source evidence without changing state: %j', (patch) => {
  const { adapter } = setup()
  adapter.bindDelegatedExecution(claim)
  const before = adapter.snapshot()
  expect(() => adapter.acceptDelegatedExecutionStatus(status(patch))).toThrow()
  expect(adapter.snapshot()).toEqual(before)
})

it('refuses source evidence before destination commit or without a bound claim', () => {
  const { adapter } = setup('prepared')
  expect(() => adapter.acceptDelegatedExecutionStatus(status())).toThrow()
  adapter.bindDelegatedExecution(claim)
  expect(() => adapter.acceptDelegatedExecutionStatus(status())).toThrow()
  adapter.commit(receipt)
  expect(adapter.acceptDelegatedExecutionStatus(status())).toMatchObject({
    executionVerdict: 'live'
  })
})

it('treats absent verdict as unverifiable and fences only the current claim', () => {
  const { adapter } = setup()
  adapter.bindDelegatedExecution(claim)
  adapter.acceptDelegatedExecutionStatus(status())
  expect(adapter.bindDelegatedExecution(claim)).toMatchObject({ executionVerdict: 'live' })
  expect(
    adapter.acceptDelegatedExecutionStatus(status({ executionVerdict: undefined }))
  ).toMatchObject({ executionVerdict: 'unverifiable' })
  adapter.bindDelegatedExecution(next)
  adapter.acceptDelegatedExecutionStatus(status({ destinationClaim: next }))
  expect(adapter.markDelegatedExecutionUnverifiable(claim)).toMatchObject({
    executionVerdict: 'live'
  })
  expect(adapter.markDelegatedExecutionUnverifiable(next)).toMatchObject({
    executionVerdict: 'unverifiable'
  })
  expect(() => adapter.acceptDelegatedExecutionStatus(status({ destinationClaim: next }))).toThrow()
  expect(() => adapter.bindDelegatedExecution(next)).toThrow()
})

it('waits for the final durable output cursor before accepting an authoritative exit', () => {
  const { adapter, publishOutput } = setup()
  adapter.bindDelegatedExecution(claim)
  const exited = status({ executionVerdict: 'exited', exit, sourceOutputEndSeq: 1 })
  expect(() => adapter.acceptDelegatedExecutionStatus(exited)).toThrow()
  expect(() =>
    adapter.acceptDelegatedExecutionStatus({ ...exited, sourceOutputEndSeq: undefined })
  ).toThrow()
  expect(adapter.snapshot().executionVerdict).toBe('unverifiable')
  adapter.acceptPostCommitOutput({ seq: 1, data: 'final output' })
  expect(publishOutput).toHaveBeenCalledOnce()
  expect(() =>
    adapter.acceptDelegatedExecutionStatus({ ...exited, sourceOutputEndSeq: 0 })
  ).toThrow()
  expect(adapter.acceptDelegatedExecutionStatus(exited)).toMatchObject({
    executionVerdict: 'exited',
    exit
  })
  expect(adapter.acceptDelegatedExecutionStatus(exited)).toMatchObject({
    executionVerdict: 'exited',
    exit
  })
})

it('preserves proven exit against disconnect, successor binding and regressing status', () => {
  const { adapter } = setup()
  adapter.bindDelegatedExecution(claim)
  const exited = status({ executionVerdict: 'exited', exit })
  adapter.acceptDelegatedExecutionStatus(exited)
  adapter.acceptDelegatedExecutionStatus(status())
  expect(adapter.markDelegatedExecutionUnverifiable(claim)).toMatchObject({
    executionVerdict: 'exited',
    exit
  })
  expect(() => adapter.acceptDelegatedExecutionStatus(status())).toThrow()
  expect(adapter.snapshot()).toMatchObject({ executionVerdict: 'exited', exit })
  adapter.bindDelegatedExecution(next)
  expect(adapter.snapshot()).toMatchObject({ executionVerdict: 'exited', exit })
  expect(() =>
    adapter.acceptDelegatedExecutionStatus(
      status({
        destinationClaim: next,
        executionVerdict: 'exited',
        exit: { ...exit, eventId: 'different' }
      })
    )
  ).toThrow()
  expect(adapter.snapshot()).toMatchObject({ executionVerdict: 'exited', exit })
})
