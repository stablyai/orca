import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStore, testState } from '../persistence-test-harness'
import { PtyOwnershipTransferDestinationRuntimeRegistry } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-runtime'
import { decommissionOrcadHostIfIdle } from './orcad-host-decommission'
import {
  identity,
  preparation,
  request
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import type { OrcadDecommissionResult } from '../../shared/orcad-decommission'
import * as durable from '../durable-file-write'
import type { OrcadNativeDecommissionResult } from './orcad-daemon-supervision'
import type { OrcadManagedStopAuthority } from '../../shared/orcad-managed-stop-authority'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-host-decommission-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})
const result = {
  ...identity,
  version: 1 as const,
  phase: 'prepared' as const,
  sourceOutputEndSeq: 0,
  replayStartSeq: 1,
  surfacePublication: preparation.surfacePublication
}
const source = {
  version: 1,
  proof: request(),
  endpoint: '/incumbent.sock',
  incumbentVersion: 'incumbent',
  endpointCredential: 'secret'
}
function registry() {
  return new PtyOwnershipTransferDestinationRuntimeRegistry({
    runtimeId: identity.destinationRuntimeId,
    store: createStore(),
    publishPostCommitOutput: vi.fn(),
    publishPostCommitOutputAcknowledged: vi.fn()
  })
}

function stopAuthority(): OrcadManagedStopAuthority {
  return {
    runtimeId: identity.destinationRuntimeId,
    profileId: 'profile',
    profileRoot: realpathSync(createStore().getProfileStorageDirectory()),
    transactionId: '11111111-1111-4111-8111-111111111111'
  }
}

it('requires exact native reopening observed by this live registry, not merely an open file', async () => {
  const host = registry()
  const authority = stopAuthority()
  expect(() => host.assertConfirmedNativeReopeningFor(authority)).toThrow(
    'native_reopening_unverifiable'
  )
  await decommissionOrcadHostIfIdle(host, async () => reopenedRefusal, authority)
  expect(() => host.assertConfirmedNativeReopeningFor(authority)).not.toThrow()
  expect(() =>
    host.assertConfirmedNativeReopeningFor({
      ...authority,
      transactionId: '22222222-2222-4222-8222-222222222222'
    })
  ).toThrow('native_reopening_unverifiable')
  expect(() => registry().assertConfirmedNativeReopeningFor(authority)).toThrow(
    'native_reopening_unverifiable'
  )
  host.fenceAdmissionForDecommission(authority)
  expect(() => host.assertConfirmedNativeReopeningFor(authority)).toThrow(
    'native_reopening_unverifiable'
  )
})

it('invalidates prior native proof when a subsequent stop loses contact', async () => {
  const host = registry()
  const authority = stopAuthority()
  await decommissionOrcadHostIfIdle(host, async () => reopenedRefusal, authority)
  await expect(
    decommissionOrcadHostIfIdle(
      host,
      async () => {
        throw new Error('contact lost')
      },
      authority
    )
  ).rejects.toThrow('contact lost')
  expect(() => host.assertConfirmedNativeReopeningFor(authority)).toThrow(
    'native_reopening_unverifiable'
  )
})

it('invalidates native proof if another reopening write is unconfirmed', async () => {
  const host = registry()
  const authority = stopAuthority()
  await decommissionOrcadHostIfIdle(host, async () => reopenedRefusal, authority)
  vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce(() => {
    throw new Error('write unconfirmed')
  })
  expect(() => host.reopenAdmissionAfterConfirmedNativeRefusal(authority)).toThrow(
    'write unconfirmed'
  )
  expect(() => host.assertConfirmedNativeReopeningFor(authority)).toThrow(
    'native_reopening_unverifiable'
  )
})

it('coalesces only the exact bound authority and preserves it across async reopening', async () => {
  const host = registry()
  const authority = stopAuthority()
  const original = { ...authority }
  let finish!: (result: OrcadNativeDecommissionResult) => void
  const retire = vi.fn(
    () =>
      new Promise<OrcadNativeDecommissionResult>((resolve) => {
        finish = resolve
      })
  )
  const first = decommissionOrcadHostIfIdle(host, retire, authority)
  expect(decommissionOrcadHostIfIdle(host, retire, { ...authority })).toBe(first)
  const rejectedRetire = vi.fn(async () => ({ outcome: 'accepted' as const }))
  for (const other of [
    undefined,
    { ...authority, transactionId: '22222222-2222-4222-8222-222222222222' },
    { ...authority, profileId: 'other' }
  ]) {
    await expect(decommissionOrcadHostIfIdle(host, rejectedRetire, other)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_authority_conflict'
    })
  }
  expect(rejectedRetire).not.toHaveBeenCalled()
  authority.transactionId = '33333333-3333-4333-8333-333333333333'
  finish(reopenedRefusal)
  await expect(first).resolves.toMatchObject({ terminalAdmission: 'open' })
  expect(retire).toHaveBeenCalledOnce()
  expect(() => host.prepare(result)).not.toThrow()
  expect(() => registry().reopenAdmissionAfterConfirmedNativeRefusal(original)).not.toThrow()
})

it('refuses bound stop while an unbound retirement is pending', async () => {
  const host = registry()
  let finish!: (result: OrcadNativeDecommissionResult) => void
  const retire = vi.fn(
    () =>
      new Promise<OrcadNativeDecommissionResult>((resolve) => {
        finish = resolve
      })
  )
  const first = decommissionOrcadHostIfIdle(host, retire)
  await expect(decommissionOrcadHostIfIdle(host, retire, stopAuthority())).resolves.toMatchObject({
    code: 'orcad_decommission_authority_conflict',
    verdict: 'unverifiable'
  })
  expect(retire).toHaveBeenCalledOnce()
  finish({ outcome: 'accepted' })
  await first
})

it('retains bound fence ownership after restart and refuses unauthorized reopening', async () => {
  const authority = stopAuthority()
  const retire = vi.fn(async () => ({ outcome: 'accepted' as const }))
  await expect(decommissionOrcadHostIfIdle(registry(), retire, authority)).resolves.toMatchObject({
    outcome: 'accepted'
  })
  const restarted = registry()
  const wrong = { ...authority, transactionId: '22222222-2222-4222-8222-222222222222' }
  expect(() => restarted.reopenAdmissionAfterConfirmedNativeRefusal(wrong)).toThrow(
    'authority_mismatch'
  )
  expect(() => restarted.reopenAdmissionAfterConfirmedNativeRefusal()).toThrow('authority_mismatch')
  retire.mockClear()
  for (const other of [wrong, undefined]) {
    await expect(decommissionOrcadHostIfIdle(restarted, retire, other)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable'
    })
  }
  expect(retire).not.toHaveBeenCalled()
  expect(() => restarted.prepare(result)).toThrow('admission_closed')
  await expect(decommissionOrcadHostIfIdle(restarted, retire, authority)).resolves.toMatchObject({
    outcome: 'accepted'
  })
  expect(retire).toHaveBeenCalledOnce()
})

it('fences fresh ordinary, delegated and captured admission before native retirement resolves', async () => {
  const host = registry()
  let finish!: (value: OrcadDecommissionResult) => void
  const retire = vi.fn(
    () =>
      new Promise<OrcadDecommissionResult>((resolve) => {
        finish = resolve
      })
  )
  const stopping = decommissionOrcadHostIfIdle(host, retire)
  expect(retire).toHaveBeenCalledOnce()
  expect(() => host.prepare(result)).toThrow('admission_closed')
  expect(() => host.prepareDelegated(result, source)).toThrow('admission_closed')
  await expect(host.prepareCapturedDelegated({} as never)).rejects.toThrow('admission_closed')
  expect(host.listRecoveryCandidates()).toEqual([])
  finish({ outcome: 'accepted' })
  await expect(stopping).resolves.toEqual({ outcome: 'accepted' })
  expect(() => host.prepare(result)).toThrow('admission_closed')
  expect(() => registry().prepare(result)).toThrow('admission_closed')
})

it.each([false, true])(
  'never stops the native daemon after an uncertain admission record write (written=%s)',
  async (written) => {
    const host = registry()
    const write = durable.writeFileDurableSync
    vi.spyOn(durable, 'writeFileDurableSync').mockImplementation((...args) => {
      if (written) {
        write(...args)
      }
      throw new Error('admission record write failed')
    })
    const retire = vi.fn(async () => ({ outcome: 'accepted' as const }))
    await expect(decommissionOrcadHostIfIdle(host, retire)).resolves.toMatchObject({
      outcome: 'refused'
    })
    expect(retire).not.toHaveBeenCalled()
    expect(() => host.prepare(result)).toThrow('admission_closed')
    vi.restoreAllMocks()
    if (written) {
      expect(() => registry().prepare(result)).toThrow('admission_closed')
    } else {
      expect(() => registry().prepare(result)).not.toThrow()
    }
  }
)

it('keeps transfer admission closed after a lost native stop reply', async () => {
  const host = registry()
  await expect(
    decommissionOrcadHostIfIdle(host, async () => {
      throw new Error('lost stop reply')
    })
  ).rejects.toThrow('lost stop reply')
  expect(() => host.prepareDelegated(result, source)).toThrow('admission_closed')
})

it('reports retained transfer admission fencing when native retirement is refused', async () => {
  const host = registry()
  await expect(
    decommissionOrcadHostIfIdle(host, async () => ({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'native-uncertain',
      reason: 'Native stop is uncertain.'
    }))
  ).resolves.toMatchObject({
    outcome: 'refused',
    reason: expect.stringContaining('remains durably fenced')
  })
  expect(() => host.prepare(result)).toThrow('admission_closed')
})

it.each([false, true])(
  'refuses a durable pending transfer even without an in-memory adapter (delegated=%s)',
  async (delegated) => {
    const host = registry()
    if (delegated) {
      host.prepareDelegated(result, source)
    } else {
      host.prepare(result)
    }
    const reopened = registry()
    expect(reopened.get(identity.bridgeId)).toBeNull()
    const retire = vi.fn(async () => ({ outcome: 'accepted' as const }))
    await expect(decommissionOrcadHostIfIdle(reopened, retire)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable'
    })
    expect(retire).not.toHaveBeenCalled()
    expect(() => host.prepare(result)).not.toThrow()
  }
)

it.each(['prepared', 'applied'] as const)(
  'only completed retirement permits host decommission (%s)',
  async (phase) => {
    const host = registry()
    const transfer = host.prepareDelegated(result, source)
    transfer.adapter.commit({
      bridgeId: identity.bridgeId,
      receiptId: 'receipt',
      acceptedSourceEndSeq: 0,
      committedAt: '2026-09-06T00:00:00Z'
    })
    transfer.adapter.publish()
    const event = {
      identity,
      surfaceBinding: preparation.surfacePublication.surfaceBinding,
      destinationClaim: { generation: 1, claimId: 'retired' },
      finalOutputSeq: 0,
      exit: { verdict: 'exited', code: 0, eventId: 'exit', observedAt: '2026-09-06T00:00:00Z' }
    }
    transfer.outputOutbox.recordRetirement(identity, { phase: 'prepared', event })
    if (phase === 'applied') {
      transfer.outputOutbox.recordRetirement(identity, { phase, event })
    }
    const retire = vi.fn(async () => ({ outcome: 'accepted' as const }))
    await expect(decommissionOrcadHostIfIdle(registry(), retire)).resolves.toMatchObject({
      outcome: phase === 'applied' ? 'accepted' : 'refused'
    })
    expect(retire).toHaveBeenCalledTimes(phase === 'applied' ? 1 : 0)
    expect(transfer.outputOutbox.loadRetirement(identity)?.phase).toBe(phase)
  }
)

it('refuses missing registry authority', async () => {
  const retire = vi.fn()
  await expect(decommissionOrcadHostIfIdle(null, retire)).resolves.toMatchObject({
    outcome: 'refused',
    verdict: 'unverifiable'
  })
  expect(retire).not.toHaveBeenCalled()
})

const reopenedRefusal = {
  outcome: 'refused',
  verdict: 'live',
  code: 'native-busy',
  reason: 'Sessions remain live.',
  admissionReopened: true
} as const

it('keeps legacy clients fenced when native sessions are live but admission did not reopen', async () => {
  const { admissionReopened: _proof, ...partialRefusal } = reopenedRefusal
  const response = await decommissionOrcadHostIfIdle(registry(), async () => partialRefusal)
  expect(response).toMatchObject({
    outcome: 'refused',
    verdict: 'unverifiable',
    terminalAdmission: 'fenced',
    reason: expect.stringContaining('Sessions remain live.')
  })
})

it('refences a later stop after a confirmed refusal reopened admission', async () => {
  const host = registry()
  await decommissionOrcadHostIfIdle(host, async () => reopenedRefusal)
  await expect(
    decommissionOrcadHostIfIdle(host, async () => ({ outcome: 'accepted' }))
  ).resolves.toEqual({ outcome: 'accepted' })
  expect(() => host.prepare(result)).toThrow('admission_closed')
  expect(() => registry().prepare(result)).toThrow('admission_closed')
})

it('coalesces concurrent stops and strips reopening evidence from the public reply', async () => {
  const host = registry()
  let finish!: (result: OrcadNativeDecommissionResult) => void
  const retire = vi.fn(
    () =>
      new Promise<OrcadNativeDecommissionResult>((resolve) => {
        finish = resolve
      })
  )
  const first = decommissionOrcadHostIfIdle(host, retire)
  const second = decommissionOrcadHostIfIdle(host, retire)
  expect(second).toBe(first)
  expect(retire).toHaveBeenCalledOnce()
  expect(() => host.prepare(result)).toThrow('admission_closed')
  finish(reopenedRefusal)
  const reply = await first
  expect(reply).not.toHaveProperty('admissionReopened')
  expect(reply).toMatchObject({ reason: reopenedRefusal.reason, terminalAdmission: 'open' })
  expect(() => registry().prepare(result)).not.toThrow()
  expect(() => host.prepare(result)).not.toThrow()
})

it.each([false, true])(
  'keeps memory fenced after uncertain reopening persistence (written=%s)',
  async (written) => {
    const host = registry()
    const write = durable.writeFileDurableSync
    const retire = vi.fn(async () => {
      vi.spyOn(durable, 'writeFileDurableSync').mockImplementation((...args) => {
        if (written) {
          write(...args)
        }
        throw new Error('reopening write failed')
      })
      return reopenedRefusal
    })
    await expect(decommissionOrcadHostIfIdle(host, retire)).resolves.toMatchObject({
      reason: expect.stringContaining('durable reopening could not be confirmed'),
      terminalAdmission: 'fenced'
    })
    expect(() => host.prepare(result)).toThrow('admission_closed')
    vi.restoreAllMocks()
    if (written) {
      // Native admission was positively reopened before this record was written.
      expect(() => registry().prepare(result)).not.toThrow()
    } else {
      expect(() => registry().prepare(result)).toThrow('admission_closed')
    }
  }
)
