import { afterEach, expect, it, vi } from 'vitest'
import { CHECKPOINT_CHUNK_BYTES } from '@xterm/addon-image/src/ImageCheckpointResources'
import { PTY_ID } from './headless-hydration-ownership-test-fixture'
import {
  captureRuntime,
  createCheckpointRuntime,
  kittyImage,
  MODEL_BUDGET
} from './headless-model-checkpoint-test-fixture'
import { makeDeferred } from './orca-runtime-test-fixtures.spec'
import {
  TerminalModelCheckpointLeases,
  TERMINAL_MODEL_LEASE_TTL_MS
} from './terminal-model-checkpoint-leases'

const owner = { viewerId: 'trusted-viewer', ptyId: PTY_ID }
const registries: TerminalModelCheckpointLeases[] = []
function registry(bytes = MODEL_BUDGET * 2) {
  const leases = new TerminalModelCheckpointLeases(bytes)
  registries.push(leases)
  return leases
}

afterEach(() => {
  for (const leases of registries.splice(0)) {
    leases.dispose()
  }
  vi.useRealTimers()
})

async function published() {
  const runtime = createCheckpointRuntime()
  const leases = registry()
  runtime.onPtyData(PTY_ID, `FIRST${kittyImage()}`, 1)
  const captured = await captureRuntime(runtime)
  const descriptor = await leases.capture(owner, async () => captured)
  if (!descriptor) {
    throw new Error('Expected terminal checkpoint lease')
  }
  return { runtime, leases, captured, descriptor }
}

it('serves coherent metadata and owned resource chunks from a real complete model', async () => {
  const { leases, captured, descriptor } = await published()
  const metadata = leases.read(owner, {
    leaseId: descriptor.leaseId,
    resourceId: null,
    offset: 0,
    length: descriptor.metadataByteLength
  })
  expect(JSON.parse(new TextDecoder().decode(metadata))).toEqual(
    JSON.parse(JSON.stringify(captured.checkpoint.metadata))
  )
  expect(descriptor.sourceSeq).toBe(`FIRST${kittyImage()}`.length)
  for (const resource of captured.checkpoint.metadata.graphics.resources) {
    const window = { leaseId: descriptor.leaseId, resourceId: resource.id, offset: 0, length: 1 }
    const bytes = leases.read(owner, window)
    const original = bytes[0]
    bytes[0] = 0
    expect(leases.read(owner, window)[0]).toBe(original)
  }
  const retained = captured.checkpoint.metadata.byteLength + metadata.byteLength
  expect(leases.byteSize).toBe(retained)
  metadata.fill(0)
  expect(
    leases.read(owner, { leaseId: descriptor.leaseId, resourceId: null, offset: 0, length: 1 })[0]
  ).toBe('{'.charCodeAt(0))
})

it('keeps a snapshot lease readable while newer output continues in its original model', async () => {
  const { runtime, leases, captured, descriptor } = await published()
  const resources = captured.checkpoint.metadata.graphics.resources.map((resource) => ({
    ...resource,
    bytes: captured.checkpoint.copyResource(resource.id, resource.byteLength)
  }))
  runtime.onPtyData(PTY_ID, `LATER${kittyImage(8)}`, 2)
  await runtime.model().writeChain
  expect(() => captured.checkCurrent()).toThrow('changed after capture')
  const bytes = leases.read(owner, {
    leaseId: descriptor.leaseId,
    resourceId: null,
    offset: 0,
    length: descriptor.metadataByteLength
  })
  const text = new TextDecoder().decode(bytes)
  expect(text).toContain('FIRST')
  expect(text).not.toContain('LATER')
  for (const resource of resources) {
    expect(
      leases.read(owner, {
        leaseId: descriptor.leaseId,
        resourceId: resource.id,
        offset: 0,
        length: resource.byteLength
      })
    ).toEqual(resource.bytes)
  }
})

it.each([
  { viewerId: 'other-viewer', ptyId: PTY_ID },
  { viewerId: owner.viewerId, ptyId: 'other-pty' }
])('refuses reads and release from another authenticated owner %j', async (other) => {
  const { leases, captured, descriptor } = await published()
  const window = { leaseId: descriptor.leaseId, resourceId: null, offset: 0, length: 1 }
  expect(() => leases.read(other, window)).toThrow('Invalid or expired')
  expect(leases.release(other, descriptor.leaseId)).toBe(false)
  expect(captured.checkpoint.isDisposed).toBe(false)
  expect(leases.read(owner, window)).toHaveLength(1)
})

it.each(['generation', 'incarnation'] as const)(
  'revokes resources after a changed %s',
  async (kind) => {
    const { runtime, leases, captured, descriptor } = await published()
    runtime.changeCaptureContext(kind)
    expect(() =>
      leases.read(owner, { leaseId: descriptor.leaseId, resourceId: null, offset: 0, length: 1 })
    ).toThrow('Invalid or expired')
    expect(captured.checkpoint.isDisposed).toBe(true)
    expect(leases.byteSize).toBe(0)
  }
)

it('releases resources after model replacement', async () => {
  const { runtime, leases, captured, descriptor } = await published()
  runtime.notePtyDataGap(PTY_ID)
  runtime.onPtyData(PTY_ID, 'NEW MODEL', 2)
  await runtime.model().writeChain
  expect(() =>
    leases.read(owner, { leaseId: descriptor.leaseId, resourceId: null, offset: 0, length: 1 })
  ).toThrow('Invalid or expired')
  expect(captured.checkpoint.isDisposed).toBe(true)
})

it.each([
  { offset: -1, length: 1 },
  { offset: 0.5, length: 1 },
  { offset: 0, length: CHECKPOINT_CHUNK_BYTES + 1 },
  { offset: 0, length: 0 },
  { offset: Number.NaN, length: 1 },
  { offset: Number.MAX_SAFE_INTEGER, length: 1 }
])('bounds metadata resource reads %j', async (range) => {
  const { leases, descriptor } = await published()
  expect(() =>
    leases.read(owner, { leaseId: descriptor.leaseId, resourceId: null, ...range })
  ).toThrow('window')
  expect(leases.release(owner, descriptor.leaseId)).toBe(true)
})

it('lets the addon validate binary resource ids and windows', async () => {
  const { leases, captured, descriptor } = await published()
  const resource = captured.checkpoint.metadata.graphics.resources[0]
  if (!resource) {
    throw new Error('Expected image resource')
  }
  for (const window of [
    { resourceId: resource.id + 1000, offset: 0, length: 1 },
    { resourceId: resource.id, offset: resource.byteLength, length: 1 }
  ]) {
    expect(() => leases.read(owner, { leaseId: descriptor.leaseId, ...window })).toThrow('resource')
  }
})

it('expires an idle lease without another request and never extends it on reads', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const { leases, captured, descriptor } = await published()
  const window = { leaseId: descriptor.leaseId, resourceId: null, offset: 0, length: 1 }
  vi.advanceTimersByTime(TERMINAL_MODEL_LEASE_TTL_MS - 1)
  expect(leases.read(owner, window)).toHaveLength(1)
  vi.advanceTimersByTime(1)
  expect(captured.checkpoint.isDisposed).toBe(true)
  expect(leases.byteSize).toBe(0)
  expect(() => leases.read(owner, window)).toThrow('Invalid or expired')
})

it('checks monotonic expiry even before the timer callback runs', async () => {
  const { leases, captured, descriptor } = await published()
  const expired = performance.now() + TERMINAL_MODEL_LEASE_TTL_MS + 1
  vi.spyOn(performance, 'now').mockReturnValue(expired)
  expect(() =>
    leases.read(owner, { leaseId: descriptor.leaseId, resourceId: null, offset: 0, length: 1 })
  ).toThrow('Invalid or expired')
  expect(captured.checkpoint.isDisposed).toBe(true)
})

it.each(['viewer', 'pty', 'dispose'] as const)(
  'cancels pending capture on %s release',
  async (kind) => {
    const runtime = createCheckpointRuntime()
    const captured = await captureRuntime(runtime)
    const leases = registry()
    const gate = makeDeferred()
    const pending = leases.capture(owner, async () => {
      await gate.promise
      return captured
    })
    if (kind === 'viewer') {
      leases.releaseViewer(owner.viewerId)
    } else if (kind === 'pty') {
      leases.releasePty(owner.ptyId)
    } else {
      leases.dispose()
    }
    gate.resolve()
    await expect(pending).resolves.toBeNull()
    expect(captured.checkpoint.isDisposed).toBe(true)
    expect(leases.byteSize).toBe(0)
  }
)

it('reserves aggregate memory before capture and releases it after rejection', async () => {
  const leases = registry()
  const gate = makeDeferred()
  const first = leases.capture(owner, async (budget) => {
    expect(budget).toBe(MODEL_BUDGET)
    await gate.promise
    throw new Error('capture failed')
  })
  expect(leases.byteSize).toBe(MODEL_BUDGET * 2)
  const blocked = vi.fn()
  await expect(leases.capture(owner, blocked)).resolves.toBeNull()
  expect(blocked).not.toHaveBeenCalled()
  gate.resolve()
  await expect(first).rejects.toThrow('capture failed')
  expect(leases.byteSize).toBe(0)
  await expect(leases.capture(owner, async () => null)).resolves.toBeNull()
  expect(leases.byteSize).toBe(0)
})

it.each(['viewer', 'pty'] as const)(
  'releases published resources for only the disconnected %s',
  async (kind) => {
    const { leases, captured, descriptor } = await published()
    leases.releaseViewer('another-viewer')
    leases.releasePty('another-pty')
    expect(captured.checkpoint.isDisposed).toBe(false)
    if (kind === 'viewer') {
      leases.releaseViewer(owner.viewerId)
    } else {
      leases.releasePty(owner.ptyId)
    }
    expect(captured.checkpoint.isDisposed).toBe(true)
    expect(leases.byteSize).toBe(0)
    expect(leases.release(owner, descriptor.leaseId)).toBe(false)
  }
)

it('refuses additional leases at the count limit without evicting a reader', async () => {
  const runtime = createCheckpointRuntime()
  const leases = registry()
  let firstId = ''
  for (let i = 0; i < 32; i++) {
    const descriptor = await leases.capture(owner, (budget) =>
      runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, budget)
    )
    if (!descriptor) {
      throw new Error('Expected bounded lease')
    }
    firstId ||= descriptor.leaseId
  }
  const blocked = vi.fn()
  await expect(leases.capture(owner, blocked)).resolves.toBeNull()
  expect(blocked).not.toHaveBeenCalled()
  expect(
    leases.read(owner, { leaseId: firstId, resourceId: null, offset: 0, length: 1 })
  ).toHaveLength(1)
})

it('revokes a lease after later parsing fails without claiming a coherent live model', async () => {
  const { runtime, leases, captured, descriptor } = await published()
  vi.spyOn(runtime.model().emulator, 'write').mockRejectedValueOnce(new Error('decode failed'))
  runtime.onPtyData(PTY_ID, 'LATER', 2)
  await runtime.model().writeChain
  expect(() =>
    leases.read(owner, { leaseId: descriptor.leaseId, resourceId: null, offset: 0, length: 1 })
  ).toThrow('Invalid or expired')
  expect(captured.checkpoint.isDisposed).toBe(true)
  expect(leases.byteSize).toBe(0)
})
