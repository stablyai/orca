import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  prepareOutgoingOrcadTerminal,
  prepareOutgoingOrcadTerminalUnderAuthority,
  prepareOutgoingOrcadTerminalFromProvider,
  recoverOutgoingOrcadPreparation
} from './orcad-outgoing-terminal-preparation'
import { OrcadOutgoingPreparationStore } from './orcad-outgoing-preparation-store'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import { targetLifecycleInFlight, runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  capture: vi.fn(),
  publish: vi.fn(),
  target: vi.fn(),
  environment: vi.fn(),
  create: vi.fn()
}))
vi.mock('./orcad-outgoing-preparation-creation', () => ({
  createOutgoingOrcadPreparation: mocks.create
}))
vi.mock('./orcad-outgoing-source-preparation', () => ({
  prepareOutgoingOrcadSource: mocks.prepare
}))
vi.mock('./orcad-outgoing-source-capture', () => ({ captureOutgoingOrcadSource: mocks.capture }))
vi.mock('./orcad-outgoing-capture-publication', () => ({
  publishOutgoingOrcadCapture: mocks.publish
}))
vi.mock('./orcad-managed-runtime-context', () => ({
  requireManagedOrcadTargetStore: () => ({ getTarget: mocks.target })
}))
vi.mock('./orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: async () => undefined }))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: mocks.environment }))
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-terminal-prep-'))
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  vi.clearAllMocks()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const source = createOrcadModelImportFixture(root)
  const calls: string[] = []
  const target = { id: 'source', host: 'host', generation: 1 }
  mocks.target.mockReturnValue(target)
  mocks.environment.mockReturnValue({
    id: 'destination',
    runtimeId: identity.destinationRuntimeId,
    createdAt: 1,
    preferredEndpointId: 'endpoint',
    endpoints: [
      { id: 'endpoint', endpoint: 'ws://host:1234', deviceToken: 'token', publicKeyB64: 'key' }
    ]
  })
  const active = (options: { assertAuthority: () => void }) => {
    expect(targetLifecycleInFlight.has('source')).toBe(true)
    expect(targetLifecycleInFlight.has(`runtime-ssh-access:${root}:destination`)).toBe(true)
    options.assertAuthority()
  }
  mocks.prepare.mockImplementation(async (options) => {
    active(options)
    calls.push('prepare')
    return { intent: options.store.persist(options.preparation) }
  })
  mocks.capture.mockImplementation(async (options) => {
    active(options)
    calls.push('capture')
    return options.store.persist({
      ...options.destination,
      version: 1,
      identity,
      model: source.model,
      selection: source.selection
    })
  })
  mocks.publish.mockImplementation(async (options) => {
    active(options)
    calls.push('publish')
    expect(options.store.read(identity)).not.toBeNull()
    return { outcome: 'published' }
  })
  const args = {
    preparation: {
      version: 1,
      kind: 'preparation',
      identity,
      source: source.store.loadDelegatedSource(identity),
      destinationEnvironmentId: 'destination',
      sourceSshTargetId: 'source',
      sourceSshTargetGeneration: 1,
      surfaceBinding: preparation.surfacePublication.surfaceBinding
    },
    ptyId: `ssh:source@@${identity.terminalId}`,
    signal: new AbortController().signal,
    runtime: { serializeSshPtyOwnershipCapture: vi.fn() }
  }
  return { args, calls, target }
}
it('runs preparation, capture and publication under one lifecycle authority', async () => {
  const f = fixture()
  await expect(prepareOutgoingOrcadTerminal(root, f.args)).resolves.toEqual({
    outcome: 'published'
  })
  expect(f.calls).toEqual(['prepare', 'capture', 'publish'])
  expect(new OrcadOutgoingPreparationStore(root).read(identity)).not.toBeNull()
  expect(new OrcadOutgoingCaptureStore(root).read(identity)).not.toBeNull()
})

it('runs under caller-held queues without reacquisition and uses the pinned authority', async () => {
  const f = fixture()
  const authority = { pairingCode: 'pinned', assertAuthority: vi.fn() }
  await runTargetLifecycle(`runtime-ssh-access:${root}:destination`, () =>
    runTargetLifecycle('source', async () => {
      await Promise.resolve()
      await expect(
        prepareOutgoingOrcadTerminalUnderAuthority(root, f.args, authority)
      ).resolves.toEqual({ outcome: 'published' })
      expect(f.calls).toEqual(['prepare', 'capture', 'publish'])
      expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ pairingCode: 'pinned' }))
      f.calls.length = 0
      await prepareOutgoingOrcadTerminalUnderAuthority(root, f.args, authority)
      expect(f.calls).toEqual(['publish'])
    })
  )
  expect(authority.assertAuthority).toHaveBeenCalled()
})

it('fences the inner operation before source contact when caller authority is lost', async () => {
  const f = fixture()
  await expect(
    prepareOutgoingOrcadTerminalUnderAuthority(root, f.args, {
      pairingCode: 'pinned',
      assertAuthority: () => {
        throw new Error('authority changed')
      }
    })
  ).rejects.toThrow('authority changed')
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(mocks.capture).not.toHaveBeenCalled()
  expect(mocks.publish).not.toHaveBeenCalled()
})
it('resumes persisted preparation after a lost prepare reply without creating new authority', async () => {
  const f = fixture()
  const prepare = mocks.prepare.getMockImplementation()!
  mocks.prepare.mockImplementationOnce(async (options) => {
    await prepare(options)
    throw new Error('prepare reply lost')
  })
  await expect(prepareOutgoingOrcadTerminal(root, f.args)).rejects.toThrow('prepare reply lost')
  const before = new OrcadOutgoingPreparationStore(root).read(identity)
  await expect(
    recoverOutgoingOrcadPreparation(root, {
      identity,
      runtime: f.args.runtime,
      signal: f.args.signal
    })
  ).resolves.toEqual({ outcome: 'published' })
  expect(new OrcadOutgoingPreparationStore(root).read(identity)).toEqual(before)
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.prepare.mock.calls[1][0].preparation).toEqual(before)
  expect(mocks.prepare.mock.calls[1][0].ptyId).toBe(f.args.ptyId)
  expect(mocks.prepare.mock.calls[0][0].recoverDurability).toBe(false)
  expect(mocks.prepare.mock.calls[1][0].recoverDurability).toBe(true)
  expect(f.calls).toEqual(['prepare', 'prepare', 'capture', 'publish'])
})
it('resumes publication only when saved preparation already has a capture', async () => {
  const f = fixture()
  mocks.publish.mockRejectedValueOnce(new Error('publication reply lost'))
  await expect(prepareOutgoingOrcadTerminal(root, f.args)).rejects.toThrow('publication reply lost')
  await recoverOutgoingOrcadPreparation(root, {
    identity,
    runtime: f.args.runtime,
    signal: f.args.signal
  })
  expect(mocks.prepare).toHaveBeenCalledOnce()
  expect(mocks.capture).toHaveBeenCalledOnce()
  expect(mocks.publish).toHaveBeenCalledTimes(2)
  expect(mocks.create).not.toHaveBeenCalled()
})
it('refuses missing intent instead of recreating it', async () => {
  const f = fixture()
  await expect(
    recoverOutgoingOrcadPreparation(root, {
      identity,
      runtime: f.args.runtime,
      signal: f.args.signal
    })
  ).rejects.toThrow('preparation_missing')
  expect(f.calls).toEqual([])
  expect(mocks.create).not.toHaveBeenCalled()
})
it('does not recreate intent that disappears before lifecycle authority is acquired', async () => {
  const f = fixture()
  const before = new OrcadOutgoingPreparationStore(root).persist(f.args.preparation)
  vi.spyOn(OrcadOutgoingPreparationStore.prototype, 'read')
    .mockReturnValueOnce(before)
    .mockReturnValue(null)
  await expect(
    recoverOutgoingOrcadPreparation(root, {
      identity,
      runtime: f.args.runtime,
      signal: f.args.signal
    })
  ).rejects.toThrow('evidence_changed')
  expect(f.calls).toEqual([])
})
it('preserves saved intent when source target authority has changed', async () => {
  const f = fixture()
  const store = new OrcadOutgoingPreparationStore(root)
  const before = store.persist(f.args.preparation)
  f.target.generation++
  await expect(
    recoverOutgoingOrcadPreparation(root, {
      identity,
      runtime: f.args.runtime,
      signal: f.args.signal
    })
  ).rejects.toThrow('target_changed')
  expect(store.read(identity)).toEqual(before)
  expect(f.calls).toEqual([])
})
it('refuses preparation recovery without canary or after cancellation', async () => {
  const f = fixture()
  new OrcadOutgoingPreparationStore(root).persist(f.args.preparation)
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '0')
  await expect(
    recoverOutgoingOrcadPreparation(root, {
      identity,
      runtime: f.args.runtime,
      signal: f.args.signal
    })
  ).rejects.toThrow('mutation_disabled')
  vi.stubEnv(PTY_OWNERSHIP_TRANSFER_CANARY_ENV, '1')
  await expect(
    recoverOutgoingOrcadPreparation(root, {
      identity,
      runtime: f.args.runtime,
      signal: AbortSignal.abort()
    })
  ).rejects.toThrow()
  expect(f.calls).toEqual([])
})
it('retries publication without preparing or recapturing after a lost publication reply', async () => {
  const f = fixture()
  mocks.publish.mockRejectedValueOnce(new Error('lost reply'))
  await expect(prepareOutgoingOrcadTerminal(root, f.args)).rejects.toThrow('lost reply')
  await prepareOutgoingOrcadTerminal(root, f.args)
  expect(mocks.prepare).toHaveBeenCalledOnce()
  expect(mocks.capture).toHaveBeenCalledOnce()
  expect(mocks.publish).toHaveBeenCalledTimes(2)
})
it('preserves preparation and does not publish after capture failure', async () => {
  const f = fixture()
  mocks.capture.mockRejectedValueOnce(new Error('capture unavailable'))
  await expect(prepareOutgoingOrcadTerminal(root, f.args)).rejects.toThrow('capture unavailable')
  expect(new OrcadOutgoingPreparationStore(root).read(identity)).not.toBeNull()
  expect(mocks.publish).not.toHaveBeenCalled()
})
it('rejects authority drift after preparation before capturing', async () => {
  const f = fixture()
  const prepare = mocks.prepare.getMockImplementation()!
  mocks.prepare.mockImplementationOnce(async (options) => {
    const result = await prepare(options)
    f.target.generation++
    return result
  })
  await expect(prepareOutgoingOrcadTerminal(root, f.args)).rejects.toThrow('authority_changed')
  expect(mocks.capture).not.toHaveBeenCalled()
  expect(mocks.publish).not.toHaveBeenCalled()
})

it('does not recapture when a failed capture attempt already saved a candidate', async () => {
  const f = fixture()
  const capture = mocks.capture.getMockImplementation()!
  mocks.capture.mockImplementationOnce(async (options) => {
    await capture(options)
    throw new Error('selection reply lost')
  })
  await expect(prepareOutgoingOrcadTerminal(root, f.args)).rejects.toThrow('selection reply lost')
  expect(mocks.publish).not.toHaveBeenCalled()
  await prepareOutgoingOrcadTerminal(root, f.args)
  expect(mocks.prepare).toHaveBeenCalledOnce()
  expect(mocks.capture).toHaveBeenCalledOnce()
  expect(mocks.publish).toHaveBeenCalledOnce()
})

it('joins intent creation to the coordinator without accepting caller-authored credentials', async () => {
  const f = fixture()
  mocks.create.mockResolvedValueOnce(f.args.preparation)
  await prepareOutgoingOrcadTerminalFromProvider(root, {
    selector: 'destination',
    surfaceBinding: f.args.preparation.surfaceBinding,
    ptyId: f.args.ptyId,
    runtime: f.args.runtime,
    signal: f.args.signal
  })
  expect(mocks.create).toHaveBeenCalledOnce()
  expect(f.calls).toEqual(['prepare', 'capture', 'publish'])
})

it('revalidates target generation between intent creation and source preparation', async () => {
  const f = fixture()
  mocks.create.mockImplementationOnce(async () => {
    f.target.generation++
    return f.args.preparation
  })
  await expect(
    prepareOutgoingOrcadTerminalFromProvider(root, {
      selector: 'destination',
      surfaceBinding: f.args.preparation.surfaceBinding,
      ptyId: f.args.ptyId,
      runtime: f.args.runtime,
      signal: f.args.signal
    })
  ).rejects.toThrow('target_changed')
  expect(mocks.prepare).not.toHaveBeenCalled()
})

it('carries the bound surface guard through source preparation before capture or publication', async () => {
  const f = fixture()
  let current = true
  mocks.create.mockResolvedValueOnce(f.args.preparation)
  const prepare = mocks.prepare.getMockImplementation()!
  mocks.prepare.mockImplementationOnce(async (options) => {
    const result = await prepare(options)
    current = false
    return result
  })
  await expect(
    prepareOutgoingOrcadTerminalFromProvider(root, {
      selector: 'destination',
      surfaceBinding: f.args.preparation.surfaceBinding,
      ptyId: f.args.ptyId,
      runtime: f.args.runtime,
      signal: f.args.signal,
      assertSurface: () => {
        if (!current) {
          throw new Error('surface moved')
        }
      }
    })
  ).rejects.toThrow('surface moved')
  expect(mocks.capture).not.toHaveBeenCalled()
  expect(mocks.publish).not.toHaveBeenCalled()
  expect(new OrcadOutgoingPreparationStore(root).read(identity)).not.toBeNull()
})
