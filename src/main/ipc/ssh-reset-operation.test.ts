import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture as wireFixture } from '../ssh/ssh-relay-network-test-fixture'
import { parseSshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import { SshRelayResetIntentStore } from '../ssh/ssh-relay-reset-intent-store'
import { sshRelayResetRecordDigest } from '../ssh/ssh-relay-reset-retirement-record'
import { sshRelayResetTargetRoutingDigest } from '../ssh/ssh-relay-reset-session-binding'
import { RELAY_OWNER_RESET_CAPABILITY } from '../../shared/relay-owner-reset-contract'
import type { IPtyProvider } from '../providers/types'
import { SshResetOperationAuthorities } from './ssh-reset-operation-authority'
import { createSshResetOperation } from './ssh-reset-operation'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(prepareParticipation?: () => Promise<() => void>) {
  const wire = wireFixture()
  const directory = mkdtempSync(join(tmpdir(), 'orca-reset-operation-'))
  directories.push(directory)
  const records = new SshRelayResetIntentStore(directory)
  const target = {
    id: randomUUID(),
    generation: 1,
    label: 'host',
    host: 'example.test',
    port: 22,
    username: 'user'
  }
  const intent = parseSshRelayResetIntent({
    version: 1,
    targetId: target.id,
    targetGeneration: 1,
    targetRoutingDigest: sshRelayResetTargetRoutingDigest(target),
    clientInstanceId: 'client',
    serverBuildId: 'build',
    endpoint: {
      relayDir: '/relay',
      runtimePath: '/bun',
      runtimeKind: 'bun',
      sockPath: '/socket',
      credentialFile: '/credential',
      relayPlatform: 'linux-x64'
    },
    request: {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'runtime',
      ownerGeneration: 1,
      ownerLease: 'lease'
    }
  })
  const selection = {
    version: 1 as const,
    intentSha256: sshRelayResetRecordDigest(intent),
    clientIncarnation: randomUUID(),
    retiredAt: 1,
    leases: [],
    routes: []
  }
  const session = {}
  const sessions = new Map([[target.id, session]])
  const authorities = new SshResetOperationAuthorities(sessions)
  const authority = authorities.retain({
    intent,
    selection,
    session,
    mux: wire.mux,
    readTarget: () => target,
    assertLiveAuthority: () => {
      if (wire.mux.isDisposed()) {
        throw new Error('live transport unavailable')
      }
    },
    assertCapturedIdentity: vi.fn()
  })
  const assertSelectionCurrent = vi.fn()
  const captured = {
    mux: wire.mux,
    provider: {} as IPtyProvider,
    begin: vi.fn(() => wire.mux.fenceForRelayReset()),
    drain: vi.fn((signal: AbortSignal) => wire.mux.waitForRelayResetDrain(signal)),
    onPreparedAcknowledgment: vi.fn((): undefined => undefined),
    releaseForwardAdmission: vi.fn((assertRetired: () => void): undefined => {
      assertRetired()
      return undefined
    }),
    teardown: vi.fn(async (assertLocalRetired: () => void) => {
      expect(records.readReceipt(intent)).not.toBeNull()
      authority.removeCapturedSession(assertLocalRetired)
      return {
        assertRetired: () => {
          authority.assertPreparedAuthority()
          assertLocalRetired()
          expect(sessions.has(target.id)).toBe(false)
        }
      }
    })
  }
  const leases = {
    retireSshRemotePtyLeaseSelection: vi.fn(async () => {
      expect(records.readReceipt(intent)).not.toBeNull()
      return { assertRetired: vi.fn() }
    })
  }
  wire.dispatcher.onRequest('relay.status', async () => ({
    capabilities: [RELAY_OWNER_RESET_CAPABILITY],
    ownerReset: { version: 1, runtimeIncarnation: 'runtime' }
  }))
  wire.dispatcher.onRequest('relay.reset', async () => ({
    version: 1,
    operationId: 'reset',
    runtimeIncarnation: 'runtime',
    prepared: true
  }))
  const controller = createSshResetOperation({
    authority,
    captured,
    records,
    leases,
    assertSelectionCurrent,
    prepareParticipation
  })
  return {
    wire,
    records,
    authority,
    authorities,
    captured,
    leases,
    controller,
    intent,
    target,
    sessions,
    assertSelectionCurrent
  }
}

it('persists preparation before local retirement and coalesces concurrent callers', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  const first = f.controller.run(signal)
  const second = f.controller.run(signal)
  expect(second).toBe(first)
  const completion = await first
  expect(completion.localRetired).toBe(true)
  expect(f.records.readCompletion(f.intent)).toEqual(completion)
  expect(f.records.readArchive(f.intent)?.completion).toEqual(completion)
  expect(f.captured.onPreparedAcknowledgment).toHaveBeenCalledOnce()
  expect(f.captured.teardown).toHaveBeenCalledOnce()
  expect(f.captured.releaseForwardAdmission).toHaveBeenCalledOnce()
  expect(f.authorities.get(f.target.id)).toBeUndefined()
  expect(f.records.read(f.target.id)).toBeNull()
  expect(f.wire.sentMethods.filter((method) => method === 'relay.reset')).toHaveLength(1)
})

it('publishes the in-flight promise before a reentrant admission callback', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  let nested: ReturnType<typeof f.controller.run> | undefined
  f.captured.begin.mockImplementationOnce(() => {
    nested = f.controller.run(signal)
    f.wire.mux.fenceForRelayReset()
  })
  const running = f.controller.run(signal)
  await running
  expect(nested).toBe(running)
  expect(f.captured.begin).toHaveBeenCalledOnce()
})

it('retries a lost receipt write from retained ACK after disposal without another host request', async () => {
  const f = fixture()
  vi.spyOn(f.records, 'persistReceipt').mockImplementationOnce(async () => {
    f.wire.mux.dispose()
    throw new Error('receipt write uncertain')
  })
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    'receipt write uncertain'
  )
  expect(f.authority.preparationAcknowledgment).toBeDefined()
  expect(f.captured.teardown).not.toHaveBeenCalled()
  expect(f.leases.retireSshRemotePtyLeaseSelection).not.toHaveBeenCalled()
  f.assertSelectionCurrent.mockImplementation(() => {
    throw new Error('old live selection unavailable')
  })
  const sent = f.wire.sentMethods.length
  const result = await f.controller.run(new AbortController().signal)
  expect(f.records.readCompletion(f.intent)).toEqual(result)
  expect(f.wire.sentMethods).toHaveLength(sent)
  expect(f.captured.begin).toHaveBeenCalledOnce()
  expect(f.captured.drain).toHaveBeenCalledOnce()
})

it('reflushes a lost completion return without reissuing reset or trusting cached success', async () => {
  const f = fixture()
  const persist = f.records.persistCompletion.bind(f.records)
  vi.spyOn(f.records, 'persistCompletion').mockImplementationOnce(async (...args) => {
    await persist(...args)
    throw new Error('completion return lost')
  })
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    'completion return lost'
  )
  f.wire.mux.dispose()
  const sent = f.wire.sentMethods.length
  await expect(f.controller.run(new AbortController().signal)).resolves.toMatchObject({
    localRetired: true
  })
  expect(f.wire.sentMethods).toHaveLength(sent)
  f.sessions.set(f.target.id, {})
  await expect(f.controller.run(new AbortController().signal)).resolves.toMatchObject({
    localRetired: true
  })
  expect(f.wire.sentMethods).toHaveLength(sent)
})

it('retries an uncertain archive after local completion without issuing another reset', async () => {
  const f = fixture()
  const archive = f.records.archiveCompleted.bind(f.records)
  vi.spyOn(f.records, 'archiveCompleted').mockImplementationOnce(async (...args) => {
    await archive(...args)
    throw new Error('archive return lost')
  })
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    'archive return lost'
  )
  const previous = f.records.readArchive(f.intent)
  expect(previous).not.toBeNull()
  f.wire.mux.dispose()
  const sent = f.wire.sentMethods.length
  const completion = await f.controller.run(new AbortController().signal)
  expect(f.wire.sentMethods).toHaveLength(sent)
  expect(f.records.readArchive(f.intent)?.completion).toEqual(completion)
  expect(f.records.archiveCompleted).toHaveBeenCalledTimes(2)
})

it('resumes after retirement-marker publication without trying to persist the retired intent', async () => {
  const f = fixture()
  const retire = f.records.retireArchived.bind(f.records)
  vi.spyOn(f.records, 'retireArchived').mockImplementationOnce(async (...args) => {
    await retire(...args)
    throw new Error('retirement return lost')
  })
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    'retirement return lost'
  )
  expect(f.records.read(f.target.id)).toBeNull()
  expect(f.captured.releaseForwardAdmission).not.toHaveBeenCalled()
  expect(f.authorities.get(f.target.id)).toBe(f.authority)
  f.wire.mux.dispose()
  vi.spyOn(f.records, 'persist').mockRejectedValue(new Error('must not resurrect retired intent'))
  const sent = f.wire.sentMethods.length
  await expect(f.controller.run(new AbortController().signal)).resolves.toMatchObject({
    localRetired: true
  })
  expect(f.wire.sentMethods).toHaveLength(sent)
  expect(f.captured.teardown).toHaveBeenCalledOnce()
  expect(f.authorities.get(f.target.id)).toBeUndefined()
})

it('retains authority until forwarding release succeeds, then returns only the historical completion', async () => {
  const f = fixture()
  f.captured.releaseForwardAdmission.mockImplementationOnce(() => {
    throw new Error('release uncertain')
  })
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow('release uncertain')
  expect(f.authorities.get(f.target.id)).toBe(f.authority)
  expect(f.records.readRetiredArchive(f.intent)).not.toBeNull()
  const result = await f.controller.run(new AbortController().signal)
  expect(f.authorities.get(f.target.id)).toBeUndefined()
  const calls = f.captured.teardown.mock.calls.length
  f.sessions.set(f.target.id, {})
  const next = { ...f.intent, request: { ...f.intent.request, operationId: 'replacement' } }
  await f.records.persist(next)
  expect(await f.controller.run(new AbortController().signal)).toEqual(result)
  expect(f.records.read(f.target.id)).toEqual(next)
  expect(f.captured.teardown).toHaveBeenCalledTimes(calls)
})

it('retries verification failure after forwarding was released without losing the retained slot', async () => {
  const f = fixture()
  let released = false
  let failOnce = true
  f.captured.releaseForwardAdmission.mockImplementation((assertRetired) => {
    assertRetired()
    released = true
    return undefined
  })
  const read = f.records.readRetiredArchive.bind(f.records)
  vi.spyOn(f.records, 'readRetiredArchive').mockImplementation((intent) => {
    if (released && failOnce) {
      failOnce = false
      throw new Error('post-release verification unavailable')
    }
    return read(intent)
  })
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    'post-release verification unavailable'
  )
  expect(f.authorities.get(f.target.id)).toBe(f.authority)
  const sent = f.wire.sentMethods.length
  await expect(f.controller.run(new AbortController().signal)).resolves.toMatchObject({
    localRetired: true
  })
  expect(f.wire.sentMethods).toHaveLength(sent)
  expect(f.authorities.get(f.target.id)).toBeUndefined()
})

it('refuses selection changes before sending reset', async () => {
  const f = fixture()
  f.assertSelectionCurrent.mockImplementation(() => {
    throw new Error('selection changed')
  })
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow('selection changed')
  expect(f.wire.sentMethods).not.toContain('relay.reset')
  expect(f.records.read(f.target.id)).toBeNull()
  expect(f.captured.teardown).not.toHaveBeenCalled()
})

it('rechecks the live selection after its durable write before sending reset', async () => {
  const f = fixture()
  const persist = f.records.persistSelection.bind(f.records)
  vi.spyOn(f.records, 'persistSelection').mockImplementationOnce(async (...args) => {
    const saved = await persist(...args)
    f.assertSelectionCurrent.mockImplementation(() => {
      throw new Error('late selection change')
    })
    return saved
  })
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    'late selection change'
  )
  expect(f.wire.sentMethods).not.toContain('relay.reset')
  expect(f.records.read(f.target.id)).toEqual(f.intent)
  expect(f.records.readReceipt(f.intent)).toBeNull()
  expect(f.captured.teardown).not.toHaveBeenCalled()
})

it('refuses changed durable selection on a prepared retry before lease or transport cleanup', async () => {
  const f = fixture()
  vi.spyOn(f.records, 'persistReceipt').mockRejectedValueOnce(new Error('receipt failed'))
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow('receipt failed')
  f.wire.mux.dispose()
  vi.spyOn(f.records, 'readSelection').mockReturnValue({ ...f.authority.selection, retiredAt: 2 })
  const sent = f.wire.sentMethods.length
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow()
  expect(f.wire.sentMethods).toHaveLength(sent)
  expect(f.leases.retireSshRemotePtyLeaseSelection).not.toHaveBeenCalled()
  expect(f.captured.teardown).not.toHaveBeenCalled()
})

it('does not start a new operation for an already-aborted observer', async () => {
  const f = fixture()
  const observer = new AbortController()
  observer.abort(new Error('observation cancelled'))
  await expect(f.controller.run(observer.signal)).rejects.toThrow('observation cancelled')
  expect(f.captured.begin).not.toHaveBeenCalled()
  expect(f.wire.sentMethods).toHaveLength(0)
})

it('does not turn a disconnected unacknowledged operation into prepared recovery', async () => {
  const f = fixture()
  f.wire.dispatcher.onRequest('relay.reset', async () => {
    f.wire.mux.dispose()
    return { prepared: false }
  })
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow()
  expect(f.authority.preparationAcknowledgment).toBeUndefined()
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    'live transport unavailable'
  )
  expect(f.captured.teardown).not.toHaveBeenCalled()
})

it('waits for durable participation before fencing work or issuing any reset traffic', async () => {
  const pending = Promise.withResolvers<() => void>()
  const prepare = vi.fn(() => pending.promise)
  const current = vi.fn()
  const f = fixture(prepare)
  const running = f.controller.run(new AbortController().signal)
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
  expect(f.captured.begin).not.toHaveBeenCalled()
  expect(f.wire.sentMethods).toHaveLength(0)
  expect(f.records.read(f.target.id)).toBeNull()
  pending.resolve(current)
  await expect(running).resolves.toMatchObject({ localRetired: true })
  expect(current).toHaveBeenCalled()
  expect(f.captured.begin).toHaveBeenCalledOnce()
  expect(f.wire.sentMethods.filter((method) => method === 'relay.reset')).toHaveLength(1)
})

it('preserves original work when durable participation preparation fails', async () => {
  const prepare = vi.fn(async () => {
    throw new Error('participation flush failed')
  })
  const f = fixture(prepare)
  const session = f.sessions.get(f.target.id)
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    'participation flush failed'
  )
  expect(f.captured.begin).not.toHaveBeenCalled()
  expect(f.captured.teardown).not.toHaveBeenCalled()
  expect(f.leases.retireSshRemotePtyLeaseSelection).not.toHaveBeenCalled()
  expect(f.records.read(f.target.id)).toBeNull()
  expect(f.wire.sentMethods).toHaveLength(0)
  expect(f.sessions.get(f.target.id)).toBe(session)
  expect(f.wire.mux.isDisposed()).toBe(false)
  await expect(f.wire.mux.request('relay.status')).resolves.toMatchObject({
    ownerReset: { runtimeIncarnation: 'runtime' }
  })
})

it('does not begin after an observer aborts pending participation preparation', async () => {
  const pending = Promise.withResolvers<() => void>()
  const prepare = vi.fn(() => pending.promise)
  const f = fixture(prepare)
  const observer = new AbortController()
  const running = f.controller.run(observer.signal)
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
  observer.abort(new Error('preparation observer aborted'))
  pending.resolve(vi.fn<() => void>())
  await expect(running).rejects.toThrow('preparation observer aborted')
  expect(f.captured.begin).not.toHaveBeenCalled()
  expect(f.wire.sentMethods).toHaveLength(0)
  expect(f.captured.teardown).not.toHaveBeenCalled()
  expect(f.wire.mux.isDisposed()).toBe(false)
})

it('revalidates retained participation on prepared retries without re-enrolling', async () => {
  const current = vi.fn()
  const prepare = vi.fn(async () => current)
  const f = fixture(prepare)
  vi.spyOn(f.records, 'persistReceipt').mockRejectedValueOnce(new Error('receipt write uncertain'))
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    'receipt write uncertain'
  )
  expect(f.authority.preparationAcknowledgment).toBeDefined()
  const sent = f.wire.sentMethods.length
  current.mockImplementation(() => {
    throw new Error('participation identity changed')
  })
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    'participation identity changed'
  )
  expect(prepare).toHaveBeenCalledOnce()
  expect(f.captured.begin).toHaveBeenCalledOnce()
  expect(f.wire.sentMethods).toHaveLength(sent)
  expect(f.captured.teardown).not.toHaveBeenCalled()
  expect(f.leases.retireSshRemotePtyLeaseSelection).not.toHaveBeenCalled()
  current.mockImplementation(() => {})
  await expect(f.controller.run(new AbortController().signal)).resolves.toMatchObject({
    localRetired: true
  })
  expect(prepare).toHaveBeenCalledOnce()
  expect(f.wire.sentMethods).toHaveLength(sent)
})

it('stops retained receipt reflush immediately when participation changes during a write', async () => {
  const current = vi.fn()
  const f = fixture(async () => current)
  vi.spyOn(f.records, 'persistReceipt').mockRejectedValueOnce(new Error('receipt uncertain'))
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow('receipt uncertain')
  const persist = f.records.persist.bind(f.records)
  vi.spyOn(f.records, 'persist').mockImplementationOnce(async (...args) => {
    const saved = await persist(...args)
    current.mockImplementation(() => {
      throw new Error('participation changed during write')
    })
    return saved
  })
  const selectionWrite = vi.spyOn(f.records, 'persistSelection')
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    'participation changed during write'
  )
  expect(selectionWrite).not.toHaveBeenCalled()
  expect(f.captured.teardown).not.toHaveBeenCalled()
})
