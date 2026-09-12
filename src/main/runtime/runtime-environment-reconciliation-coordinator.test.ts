import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { RUNTIME_PROTOCOL_VERSION } from '../../shared/protocol-version'
import * as secureJson from '../../shared/bounded-secure-json-file'
import {
  addEnvironmentFromPairingCode,
  listEnvironments
} from '../../shared/runtime-environment-store'
import {
  prepareRuntimeEnvironmentReconciliation,
  cancelPreparedRuntimeEnvironmentReconciliation
} from '../../shared/runtime-environment-reconciliation-store'
import { setRuntimeEnvironmentReconciliationCatalogActive } from '../../shared/runtime-environment-reconciliation-catalog'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { enqueueRuntimeCall } from '../ipc/runtime-environment-call-queue'
import {
  transitionRuntimeEnvironmentReconciliationCatalog,
  cancelRuntimeEnvironmentReconciliation
} from './runtime-environment-reconciliation-coordinator'

const send = vi.hoisted(() => vi.fn())
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: send }))

let directory: string
const args = { environmentId: 'historical', requestId: 'request', active: true }
const retire = vi.fn()
function status(runtimeId = 'host') {
  return {
    id: 'status',
    ok: true,
    result: {
      runtimeId,
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      deviceScope: 'runtime'
    },
    _meta: { runtimeId }
  }
}
const rows = () => listEnvironments(directory)
const stage = () => rows()[0].reconciliation?.stage
const transition = (overrides: Partial<typeof args> = {}) =>
  transitionRuntimeEnvironmentReconciliationCatalog(directory, { ...args, ...overrides }, retire)

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-reconcile-coordinator-'))
  send.mockReset().mockResolvedValue(status())
  retire.mockReset()
  for (const id of ['canonical', 'historical']) {
    addEnvironmentFromPairingCode(directory, {
      id,
      name: id,
      now: 1,
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: `wss://${id}.example`,
        deviceToken: `grant-${id}`,
        publicKeyB64: Buffer.alloc(32, 1).toString('base64')
      })
    })
  }
  prepareRuntimeEnvironmentReconciliation(directory, {
    requestId: 'request',
    canonicalEnvironmentId: 'canonical',
    verifiedRuntimeId: 'host',
    expectedRegistrations: rows()
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

it('proves both original grants and retires both generations before durable catalog publication', async () => {
  const before = rows()
  retire.mockImplementation(() => expect(stage()).toBe('prepared'))
  await expect(transition()).resolves.toMatchObject({ stage: 'catalog-active' })
  expect(send.mock.calls.map(([pairing]) => pairing.deviceToken)).toEqual([
    'grant-canonical',
    'grant-historical'
  ])
  expect(retire.mock.calls).toEqual([['canonical'], ['historical']])
  expect(rows()).toEqual(
    before.map((row) => ({
      ...row,
      reconciliation: { ...row.reconciliation, stage: 'catalog-active' }
    }))
  )
})

it('retries an already-published transition without contacting the host or retiring again', async () => {
  const first = await transition()
  send.mockClear().mockRejectedValue(new Error('offline'))
  retire.mockClear()
  await expect(transition()).resolves.toEqual(first)
  expect(send).not.toHaveBeenCalled()
  expect(retire).not.toHaveBeenCalled()
})

it('serializes duplicate activation requests into one proof and retirement', async () => {
  const [first, second] = await Promise.all([transition(), transition()])
  expect(second).toEqual(first)
  expect(first.stage).toBe('catalog-active')
  expect(send).toHaveBeenCalledTimes(2)
  expect(retire).toHaveBeenCalledTimes(2)
})

it('refuses retirement while an original grant is awaiting a mutation acknowledgment', async () => {
  const pending = Promise.withResolvers<string>()
  const mutation = enqueueRuntimeCall('historical', 'terminal.send', () => pending.promise)
  try {
    await expect(transition()).rejects.toMatchObject({ code: 'runtime_rpc_queue_busy' })
    expect(retire).not.toHaveBeenCalled()
    expect(stage()).toBe('prepared')
  } finally {
    pending.resolve('original-ack')
    await expect(mutation).resolves.toBe('original-ack')
  }
  await expect(transition()).resolves.toMatchObject({ stage: 'catalog-active' })
})

it('refuses reentrant calls during publication and releases both holds when retirement fails', async () => {
  const dispatched = vi.fn(async () => 'ack')
  const rejected: Promise<void>[] = []
  retire.mockImplementation((id) => {
    rejected.push(
      expect(enqueueRuntimeCall(id, 'terminal.send', dispatched)).rejects.toMatchObject({
        code: 'runtime_rpc_queue_busy'
      })
    )
    throw new Error('retirement failed')
  })
  await expect(transition()).rejects.toThrow('Could not retire')
  await Promise.all(rejected)
  expect(dispatched).not.toHaveBeenCalled()
  for (const id of ['canonical', 'historical']) {
    await expect(enqueueRuntimeCall(id, 'terminal.send', dispatched)).resolves.toBe('ack')
  }
  expect(dispatched).toHaveBeenCalledTimes(2)
})

it('allows offline reversal and then cancellation while preserving original grants', async () => {
  const before = rows()
  await transition()
  send.mockClear().mockRejectedValue(new Error('offline'))
  await expect(cancelRuntimeEnvironmentReconciliation(directory, args)).rejects.toThrow(
    'cancellation'
  )
  await transition({ active: false })
  expect(send).not.toHaveBeenCalled()
  await cancelRuntimeEnvironmentReconciliation(directory, args)
  expect(rows()).toEqual(
    before.map((row) => {
      const copy = { ...row }
      delete copy.reconciliation
      return copy
    })
  )
})

it.each(['offline', 'wrong-host'])(
  'leaves prepared evidence unchanged on %s proof failure',
  async (failure) => {
    const before = rows()
    if (failure === 'offline') {
      send.mockRejectedValue(new Error('offline'))
    } else {
      send.mockResolvedValue(status('different-host'))
    }
    await expect(transition()).rejects.toThrow()
    expect(rows()).toEqual(before)
    expect(retire).not.toHaveBeenCalled()
  }
)

it('attempts both retirements but refuses publication if either retirement fails', async () => {
  retire.mockImplementationOnce(() => {
    throw new Error('close failed')
  })
  await expect(transition()).rejects.toThrow('Could not retire')
  expect(retire.mock.calls).toEqual([['canonical'], ['historical']])
  expect(stage()).toBe('prepared')
  retire.mockReset()
  await expect(transition()).resolves.toMatchObject({ stage: 'catalog-active' })
})

it('honors cancellation while waiting for the lifecycle lock before contacting or retiring', async () => {
  const gate = Promise.withResolvers<void>()
  const holding = runTargetLifecycle(
    `runtime-ssh-access:${directory}:canonical`,
    () => gate.promise
  )
  const controller = new AbortController()
  const pending = transitionRuntimeEnvironmentReconciliationCatalog(
    directory,
    { ...args, signal: controller.signal },
    retire
  )
  const rejected = expect(pending).rejects.toThrow('aborted')
  controller.abort()
  gate.resolve()
  await holding
  await rejected
  expect(send).not.toHaveBeenCalled()
  expect(retire).not.toHaveBeenCalled()
  expect(stage()).toBe('prepared')
})

it('refuses a canceled or changed record after verification instead of publishing stale intent', async () => {
  send.mockImplementation(async () => {
    if (stage() === 'prepared') {
      cancelPreparedRuntimeEnvironmentReconciliation(directory, args)
    }
    return status()
  })
  await expect(transition()).rejects.toThrow('no longer matches')
  expect(retire).not.toHaveBeenCalled()
  expect(stage()).toBeUndefined()
})

it('rechecks catalog stage after retirement callbacks before publishing', async () => {
  retire.mockImplementationOnce(() =>
    setRuntimeEnvironmentReconciliationCatalogActive(directory, args)
  )
  await expect(transition()).rejects.toThrow('changed during')
  expect(retire).toHaveBeenCalledTimes(2)
})

it.each(['transition', 'cancel'])(
  'rejects replaced intent queued for %s under the same request ID',
  async (operation) => {
    const gate = Promise.withResolvers<void>()
    const holding = runTargetLifecycle(
      `runtime-ssh-access:${directory}:canonical`,
      () => gate.promise
    )
    const pending =
      operation === 'transition'
        ? transition()
        : cancelRuntimeEnvironmentReconciliation(directory, args)
    const rejected = expect(pending).rejects.toThrow('changed while waiting')
    cancelPreparedRuntimeEnvironmentReconciliation(directory, args)
    prepareRuntimeEnvironmentReconciliation(directory, {
      requestId: 'request',
      canonicalEnvironmentId: 'historical',
      verifiedRuntimeId: 'host',
      expectedRegistrations: rows()
    })
    gate.resolve()
    await holding
    await rejected
    expect(stage()).toBe('prepared')
    expect(send).not.toHaveBeenCalled()
    expect(retire).not.toHaveBeenCalled()
  }
)

it.each(['before', 'after'])(
  'recovers publication failure %s the durable write without losing either grant',
  async (boundary) => {
    const originalWriter = secureJson.writeSecureJsonFileWithinLimit
    const writer = vi.spyOn(secureJson, 'writeSecureJsonFileWithinLimit')
    writer.mockImplementationOnce((...parameters) => {
      if (boundary === 'after') {
        originalWriter(...parameters)
      }
      throw new Error('publication interrupted')
    })
    await expect(transition()).rejects.toThrow('publication interrupted')
    expect(stage()).toBe(boundary === 'before' ? 'prepared' : 'catalog-active')
    expect(retire).toHaveBeenCalledTimes(2)
    writer.mockRestore()
    retire.mockClear()
    await expect(transition()).resolves.toMatchObject({ stage: 'catalog-active' })
    expect(retire).toHaveBeenCalledTimes(boundary === 'before' ? 2 : 0)
    expect(rows().map((row) => row.endpoints[0].deviceToken)).toEqual([
      'grant-canonical',
      'grant-historical'
    ])
  }
)
