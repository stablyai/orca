import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appliedCoverageFixture } from './orcad-live-applied-coverage-test-fixture'
import { cleanupOrcadLiveSuccessorRuntime } from './orcad-live-successor-runtime-cleanup'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { isOutgoingPtyRegistrationFenced } from '../runtime/outgoing-pty-registration-fence'

const mocked = vi.hoisted(() => ({ controls: vi.fn(), assertControls: vi.fn(), drain: vi.fn() }))
vi.mock('./orcad-live-successor-control-absence', () => ({
  bindOrcadLiveSuccessorControlAbsence: mocked.controls
}))
vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ disconnectAndDrain: mocked.drain })
}))
vi.mock('../ipc/ssh-ipc-context', () => ({
  portForwardManager: { listForwards: () => [], removeForwardAndWait: mocked.drain }
}))
let root: string
beforeEach(() => {
  vi.resetAllMocks()
  root = mkdtempSync(join(tmpdir(), 'orca-successor-runtime-cleanup-'))
  mocked.controls.mockImplementation(() => {
    mocked.assertControls()
    return { assertAbsent: mocked.assertControls }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const f = appliedCoverageFixture(root)
  f.evidenceStore.persist(f.create())
  let absent = false
  const assertAbsent = vi.fn(() => {
    if (!absent) {
      throw new Error('orcad_outgoing_source_runtime_surfaces_present')
    }
  })
  const remove = vi.fn(async (assertCurrent: () => void) => {
    assertCurrent()
    absent = true
  })
  const cleanup = { remove }
  const runtime = {
    bindOutgoingSshPtySurfaceAbsence: vi.fn(() => {
      assertAbsent()
      return { assertAbsent }
    }),
    prepareOutgoingSshPtyGraphAndModelCleanup: vi.fn(() => cleanup)
  }
  const assertAuthority = vi.fn()
  const controller = new AbortController()
  const run = (profileDirectory = root) =>
    cleanupOrcadLiveSuccessorRuntime({
      profileDirectory,
      record: f.record,
      runtime: runtime as never,
      signal: controller.signal,
      assertAuthority
    })
  return {
    ...f,
    removeEvidence: f.remove,
    runtime,
    remove,
    assertAbsent,
    assertAuthority,
    controller,
    run,
    setAbsent: (value: boolean) => {
      absent = value
    }
  }
}

it('skips cleanup when current surfaces are absent and remains repeat-safe', async () => {
  const f = fixture()
  f.setAbsent(true)
  await f.run()
  await f.run()
  expect(f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup).not.toHaveBeenCalled()
  expect(f.remove).not.toHaveBeenCalled()
})

it('supplies only the exact captured cohort and fences it before preparing cleanup', async () => {
  const f = fixture()
  await f.run()
  const targetId = f.record.release.cutover.manifest.source.sshTargetId
  const surfaces = f.record.release.cutover.liveTerminalBindings!.map(
    ({ identity, surfaceBinding }) => ({
      ptyId: toAppSshPtyId(targetId, identity.terminalId),
      incarnationId: identity.incarnationId,
      surfaceBinding
    })
  )
  expect(f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup).toHaveBeenCalledWith(
    targetId,
    surfaces
  )
  for (const { ptyId } of surfaces) {
    expect(isOutgoingPtyRegistrationFenced(f.runtime, ptyId)).toBe(true)
  }
  await f.run()
  expect(f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup).toHaveBeenCalledOnce()
  expect(f.remove).toHaveBeenCalledOnce()
})

it.each([
  new Error('other_failure'),
  new Error('orcad_outgoing_source_runtime_surfaces_present_extra'),
  'orcad_outgoing_source_runtime_surfaces_present'
])('only accepts the exact surfaces-present Error for cleanup', async (error) => {
  const f = fixture()
  f.runtime.bindOutgoingSshPtySurfaceAbsence.mockImplementation(() => {
    throw error
  })
  await expect(f.run()).rejects.toBe(error)
  expect(f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup).not.toHaveBeenCalled()
})

it('refuses cleanup with retained controls', async () => {
  const f = fixture()
  mocked.assertControls.mockImplementation(() => {
    throw new Error('controls_retained')
  })
  await expect(f.run()).rejects.toThrow('controls_retained')
  expect(f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup).not.toHaveBeenCalled()
})

it('requires applied evidence before touching runtime cleanup', async () => {
  const f = fixture()
  f.removeEvidence('orcad-live-applied-coverage-evidence')
  await expect(f.run()).rejects.toThrow()
  expect(f.runtime.bindOutgoingSshPtySurfaceAbsence).not.toHaveBeenCalled()
  expect(f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup).not.toHaveBeenCalled()
})

it('retries the same prepared operation after partial failure despite now-absent surfaces', async () => {
  const f = fixture()
  f.remove.mockImplementationOnce(async () => {
    f.setAbsent(true)
    throw new Error('partial_cleanup')
  })
  await expect(f.run()).rejects.toThrow('partial_cleanup')
  await f.run()
  await f.run()
  expect(f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup).toHaveBeenCalledOnce()
  expect(f.remove).toHaveBeenCalledTimes(2)
})

it.each(['abort', 'authority', 'evidence', 'controls'] as const)(
  'rejects %s loss while cleanup is pending',
  async (kind) => {
    const f = fixture()
    const pending = Promise.withResolvers<void>()
    f.remove.mockImplementationOnce(async () => {
      await pending.promise
      f.setAbsent(true)
    })
    const result = f.run()
    await vi.waitFor(() => expect(f.remove).toHaveBeenCalledOnce())
    if (kind === 'abort') {
      f.controller.abort()
    }
    if (kind === 'authority') {
      f.assertAuthority.mockImplementation(() => {
        throw new Error('authority_lost')
      })
    }
    if (kind === 'evidence') {
      f.removeEvidence('orcad-live-applied-coverage-evidence')
    }
    if (kind === 'controls') {
      mocked.assertControls.mockImplementation(() => {
        throw new Error('controls_retained')
      })
    }
    pending.resolve()
    await expect(result).rejects.toThrow()
  }
)

it('requires final absence even if remove resolves successfully', async () => {
  const f = fixture()
  f.remove.mockImplementationOnce(async () => {})
  await expect(f.run()).rejects.toThrow('surfaces_present')
  await f.run()
  expect(f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup).toHaveBeenCalledOnce()
  expect(f.remove).toHaveBeenCalledTimes(2)
})

it('rejects changed valid applied evidence before reusing a partial cleanup or taking the absent fast path', async () => {
  const f = fixture()
  f.remove.mockImplementationOnce(async () => {
    f.setAbsent(true)
    throw new Error('partial_cleanup')
  })
  await expect(f.run()).rejects.toThrow('partial_cleanup')
  const coverage = { ...f.coverage, destinationClaim: { generation: 2, claimId: 'successor' } }
  const changed = f.create([coverage])
  f.removeEvidence('orcad-live-applied-coverage-evidence')
  f.evidenceStore.persist(changed)
  await expect(f.run()).rejects.toThrow('cleanup_evidence_changed')
  expect(f.runtime.prepareOutgoingSshPtyGraphAndModelCleanup).toHaveBeenCalledOnce()
  expect(f.remove).toHaveBeenCalledOnce()
})
