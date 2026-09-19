import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { liveSourceCompletionEvidenceFixture } from './orcad-live-source-completion-evidence-test-fixture'
import {
  createOrcadLiveAppliedCoverageEvidence,
  OrcadLiveAppliedCoverageEvidenceStore
} from './orcad-live-applied-coverage-evidence'
import { cleanupOrcadLiveSuccessorRuntime } from './orcad-live-successor-runtime-cleanup'

const controls = vi.hoisted(() => ({ assertAbsent: vi.fn() }))
const manager = vi.hoisted(() => ({
  disconnectAndDrain: vi.fn(async () => {}),
  assertTargetTransportsClosed: vi.fn(),
  hasTargetActivity: vi.fn(() => false)
}))
vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => manager
}))
vi.mock('../ipc/ssh-ipc-context', () => ({
  portForwardManager: {
    listForwards: () => [],
    removeForwardAndWait: vi.fn(),
    assertTargetResourcesAbsent: vi.fn()
  }
}))
vi.mock('./orcad-live-successor-control-absence', () => ({
  bindOrcadLiveSuccessorControlAbsence: () => controls
}))
class Runtime extends OrcaRuntimeService {
  disconnect(id: string) {
    this.ptysById.get(id)!.connected = false
  }
  model(id: string) {
    return this.headlessTerminals.get(id)
  }
}
let root: string
beforeEach(() => {
  vi.resetAllMocks()
  root = mkdtempSync(join(tmpdir(), 'orca-successor-runtime-real-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it.each(['folder', 'worktree'] as const)(
  'cleans restored %s models and graphs through real runtime cleanup',
  async (kind) => {
    const f = liveSourceCompletionEvidenceFixture(root, kind)
    f.persist()
    new OrcadLiveAppliedCoverageEvidenceStore(root).persist(
      createOrcadLiveAppliedCoverageEvidence({
        profileDirectory: root,
        record: f.record,
        coverages: []
      })
    )
    const runtime = new Runtime()
    const targetId = f.committed.manifest.source.sshTargetId
    const bindings = f.committed.liveTerminalBindings!
    const leaves = bindings.map(({ identity, surfaceBinding }) => {
      const scope = parseWorkspaceKey(surfaceBinding.workspaceKey)!
      const worktreeId = scope.type === 'worktree' ? scope.worktreeId : surfaceBinding.workspaceKey
      const ptyId = toAppSshPtyId(targetId, identity.terminalId)
      runtime.registerPty(ptyId, worktreeId, targetId, {
        tabId: surfaceBinding.tabId,
        leafId: surfaceBinding.leafId,
        incarnationId: identity.incarnationId
      })
      runtime.preAllocateHandleForPty(ptyId)
      return {
        ptyId,
        worktreeId,
        tabId: surfaceBinding.tabId,
        leafId: surfaceBinding.leafId,
        paneRuntimeId: 1
      }
    })
    for (const leaf of leaves) {
      await runtime.acceptPtyDataBounded(leaf.ptyId, 'retained output\r\n', Date.now()).completion
      runtime.disconnect(leaf.ptyId)
    }
    runtime.syncWindowGraph(1, {
      leaves,
      tabs: [
        ...new Map(
          leaves.map((leaf) => [
            leaf.tabId,
            {
              tabId: leaf.tabId,
              worktreeId: leaf.worktreeId,
              title: 'source',
              activeLeafId: leaf.leafId,
              layout: null
            }
          ])
        ).values()
      ]
    })
    const dispose = leaves.map(({ ptyId }) => vi.spyOn(runtime.model(ptyId)!.emulator, 'dispose'))
    const exit = vi.spyOn(runtime, 'onPtyExit')
    const prepare = vi.spyOn(runtime, 'prepareOutgoingSshPtyGraphAndModelCleanup')
    const options = {
      profileDirectory: root,
      record: f.record,
      runtime,
      signal: new AbortController().signal,
      assertAuthority: vi.fn()
    }
    const absence = await cleanupOrcadLiveSuccessorRuntime(options)
    absence.assertAbsent()
    for (const spy of dispose) {
      expect(spy).toHaveBeenCalledOnce()
    }
    expect(exit).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledOnce()
    await cleanupOrcadLiveSuccessorRuntime(options)
    expect(prepare).toHaveBeenCalledOnce()
    for (const spy of dispose) {
      expect(spy).toHaveBeenCalledOnce()
    }
  }
)
