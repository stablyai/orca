import { beforeEach, expect, it, vi } from 'vitest'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import {
  listOutgoingOrcadRecoveryCandidates,
  recoverSelectedOutgoingOrcadCapture
} from './orcad-outgoing-recovery-selection'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  resolve: vi.fn(),
  recover: vi.fn(),
  preparations: vi.fn(),
  recoverPreparation: vi.fn(),
  enabled: vi.fn()
}))
vi.mock('./orcad-outgoing-capture-store', () => ({
  parseOrcadOutgoingSourceBinding: ({
    identity,
    destinationEnvironmentId,
    sourceSshTargetId,
    sourceSshTargetGeneration,
    source
  }: Record<string, unknown>) => ({
    identity,
    destinationEnvironmentId,
    sourceSshTargetId,
    sourceSshTargetGeneration,
    source
  }),
  OrcadOutgoingCaptureStore: class {
    list = mocks.list
  }
}))
vi.mock('./orcad-outgoing-preparation-store', () => ({
  OrcadOutgoingPreparationStore: class {
    list = mocks.preparations
  }
}))
vi.mock('./orcad-outgoing-terminal-preparation', () => ({
  recoverOutgoingOrcadPreparation: mocks.recoverPreparation
}))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: mocks.resolve }))
vi.mock('../../shared/pty-ownership-transfer-release-gate', () => ({
  isPtyOwnershipTransferMutationEnabled: mocks.enabled
}))
vi.mock('./orcad-outgoing-capture-recovery', () => ({ recoverOutgoingOrcadCapture: mocks.recover }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.enabled.mockReturnValue(true)
  mocks.preparations.mockReturnValue([])
  mocks.recoverPreparation.mockResolvedValue({ outcome: 'published', privateReceipt: 'secret' })
  mocks.resolve.mockReturnValue({ id: 'destination', runtimeId: identity.destinationRuntimeId })
  mocks.list.mockReturnValue([
    {
      identity,
      destinationEnvironmentId: 'destination',
      sourceSshTargetId: 'source',
      sourceSshTargetGeneration: 1,
      source: { credential: 'secret' },
      model: { modelData: 'private transcript' },
      selection: { private: true }
    }
  ])
  mocks.recover.mockResolvedValue({ outcome: 'published', privateReceipt: 'secret' })
})
const args = () => ({
  selector: 'destination',
  bridgeId: identity.bridgeId,
  signal: new AbortController().signal
})

it('lists only redacted candidate identity metadata, not transcripts or credentials', () => {
  expect(listOutgoingOrcadRecoveryCandidates('/profile', 'destination')).toEqual([
    {
      bridgeId: identity.bridgeId,
      terminalId: identity.terminalId,
      incarnationId: identity.incarnationId,
      destinationEnvironmentId: 'destination',
      destinationRuntimeId: identity.destinationRuntimeId,
      sourceSshTargetId: 'source',
      sourceSshTargetGeneration: 1
    }
  ])
  expect(mocks.recover).not.toHaveBeenCalled()
})

it('reuses exact saved capture recovery and exposes only publication outcome', async () => {
  const request = args()
  await expect(recoverSelectedOutgoingOrcadCapture('/profile', request)).resolves.toEqual({
    bridgeId: identity.bridgeId,
    outcome: 'published'
  })
  expect(mocks.recover).toHaveBeenCalledExactlyOnceWith('/profile', {
    identity,
    signal: request.signal
  })
})

it('does not recover a capture selected under another environment', async () => {
  mocks.resolve.mockReturnValue({ id: 'other', runtimeId: identity.destinationRuntimeId })
  expect(listOutgoingOrcadRecoveryCandidates('/profile', 'other')).toEqual([])
  await expect(recoverSelectedOutgoingOrcadCapture('/profile', args())).rejects.toThrow(
    'capture_missing'
  )
  expect(mocks.recover).not.toHaveBeenCalled()
})

it('keeps old-runtime evidence visible but refuses recovery against a repaired environment', async () => {
  mocks.resolve.mockReturnValue({ id: 'destination', runtimeId: 'replacement' })
  expect(listOutgoingOrcadRecoveryCandidates('/profile', 'destination')).toHaveLength(1)
  await expect(recoverSelectedOutgoingOrcadCapture('/profile', args())).rejects.toThrow(
    'destination_changed'
  )
  expect(mocks.recover).not.toHaveBeenCalled()
})

it('refuses mutation without the canary or after caller cancellation', async () => {
  mocks.enabled.mockReturnValue(false)
  await expect(recoverSelectedOutgoingOrcadCapture('/profile', args())).rejects.toThrow(
    'mutation_disabled'
  )
  mocks.enabled.mockReturnValue(true)
  await expect(
    recoverSelectedOutgoingOrcadCapture('/profile', { ...args(), signal: AbortSignal.abort() })
  ).rejects.toThrow()
  expect(mocks.list).not.toHaveBeenCalled()
  expect(mocks.recover).not.toHaveBeenCalled()
})

it('does not hide unreadable evidence as an empty list or recovery success', async () => {
  mocks.list.mockImplementation(() => {
    throw new Error('corrupt evidence')
  })
  expect(() => listOutgoingOrcadRecoveryCandidates('/profile', 'destination')).toThrow(
    'corrupt evidence'
  )
  await expect(recoverSelectedOutgoingOrcadCapture('/profile', args())).rejects.toThrow(
    'corrupt evidence'
  )
  expect(mocks.recover).not.toHaveBeenCalled()
})
it('includes redacted preparation only on explicit opt-in and deduplicates completed captures', () => {
  const capture = mocks.list()[0]
  mocks.preparations.mockReturnValue([{ ...capture, kind: 'preparation' }])
  expect(listOutgoingOrcadRecoveryCandidates('/profile', 'destination', true)).toHaveLength(1)
  mocks.preparations.mockReturnValue([
    { ...capture, kind: 'preparation', identity: { ...identity, bridgeId: 'pending' } }
  ])
  expect(listOutgoingOrcadRecoveryCandidates('/profile', 'destination')).toHaveLength(1)
  const listed = listOutgoingOrcadRecoveryCandidates('/profile', 'destination', true)
  expect(listed).toHaveLength(2)
  expect(listed[1]).toEqual({ ...listed[0], bridgeId: 'pending', stage: 'preparation' })
  expect(JSON.stringify(listed)).not.toContain('secret')
})
it('rejects contradictory preparation and capture bindings instead of hiding intent', () => {
  mocks.preparations.mockReturnValue([
    { ...mocks.list()[0], kind: 'preparation', sourceSshTargetGeneration: 2 }
  ])
  expect(() => listOutgoingOrcadRecoveryCandidates('/profile', 'destination', true)).toThrow(
    'evidence_changed'
  )
})
it('recovers only the selected saved preparation using the injected source runtime', async () => {
  mocks.preparations.mockReturnValue([{ ...mocks.list()[0], kind: 'preparation' }])
  const runtime = { serializeSshPtyOwnershipCapture: vi.fn() }
  const request = { ...args(), stage: 'preparation' as const, runtime }
  await expect(recoverSelectedOutgoingOrcadCapture('/profile', request)).resolves.toEqual({
    bridgeId: identity.bridgeId,
    outcome: 'published'
  })
  expect(mocks.recoverPreparation).toHaveBeenCalledExactlyOnceWith('/profile', {
    identity,
    runtime,
    signal: request.signal
  })
  expect(mocks.recover).not.toHaveBeenCalled()
})
it('does not substitute capture recovery or another runtime for unavailable preparation context', async () => {
  mocks.preparations.mockReturnValue([{ ...mocks.list()[0], kind: 'preparation' }])
  await expect(
    recoverSelectedOutgoingOrcadCapture('/profile', { ...args(), stage: 'preparation' })
  ).rejects.toThrow('runtime_unavailable')
  mocks.resolve.mockReturnValue({ id: 'other', runtimeId: identity.destinationRuntimeId })
  await expect(
    recoverSelectedOutgoingOrcadCapture('/profile', { ...args(), stage: 'preparation' })
  ).rejects.toThrow('preparation_missing')
  expect(mocks.recoverPreparation).not.toHaveBeenCalled()
  expect(mocks.recover).not.toHaveBeenCalled()
})
