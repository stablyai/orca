import { expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { fenceOutgoingPtyRegistrations } from './outgoing-pty-registration-fence'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'

const sourceId = toAppSshPtyId('source', 'pty')
class Runtime extends OrcaRuntimeService {
  issueSource() {
    return this.issuePtyHandle(this.ptysById.get(sourceId)!)
  }
  issueStructuredSource() {
    return this.issueStructuredTuiPtyHandle(this.ptysById.get(sourceId)!)
  }
  issueLeaf() {
    return this.issueHandle([...this.leaves.values()][0]!)
  }
  adoptController() {
    this.adoptControllerTerminalHandle(sourceId, 'term-replacement', 'replacement-incarnation')
  }
  adoptLeaf() {
    this.adoptPreAllocatedHandle([...this.leaves.values()][0]!)
  }
  bindIncarnation() {
    const leaf = [...this.leaves.values()][0]!
    this.bindPtyIncarnationHandle(
      { handle: 'term-retained', incarnationId: 'original', leafKey: 'old-leaf' },
      leaf
    )
  }
  adoptFirst() {
    this.adoptFirstPtyForLeafHandle('old-leaf', sourceId, 1)
  }
  snapshot() {
    return structuredClone({
      handles: [...this.handles],
      byPty: [...this.handleByPtyId],
      byLeaf: [...this.handleByLeafKey],
      byIncarnation: [...this.handleByPtyIncarnation],
      synthetic: [...this.syntheticTerminalHandles],
      ptys: [...this.ptysById]
    })
  }
}

it.each([false, true])(
  'refuses source handle admission with preallocated handle=%s',
  (allocated) => {
    const runtime = new Runtime()
    runtime.registerPty(sourceId, 'folder:source', 'source', {
      tabId: 'tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      incarnationId: 'original'
    })
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab',
          worktreeId: 'folder:source',
          title: 'Terminal',
          activeLeafId: null,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab',
          worktreeId: 'folder:source',
          leafId: '11111111-1111-4111-8111-111111111111',
          paneRuntimeId: 1,
          ptyId: sourceId
        }
      ]
    })
    if (allocated) {
      runtime.preAllocateHandleForPty(sourceId)
      runtime.issueLeaf()
    }
    const before = runtime.snapshot()
    fenceOutgoingPtyRegistrations(runtime, [sourceId])
    for (const admit of [
      () => runtime.preAllocateHandleForPty(sourceId),
      () => runtime.registerPreAllocatedHandleForPty(sourceId, 'term-replacement'),
      () => runtime.issueSource(),
      () => runtime.issueStructuredSource(),
      () => runtime.issueLeaf(),
      () => runtime.adoptController(),
      () => runtime.adoptLeaf(),
      () => runtime.bindIncarnation(),
      () => runtime.adoptFirst()
    ]) {
      expect(admit).toThrow('source_registration_fenced')
      expect(runtime.snapshot()).toEqual(before)
    }
    expect(runtime.preAllocateHandleForPty(toAppSshPtyId('other', 'pty'))).toMatch(/^term_/)
    expect(new Runtime().preAllocateHandleForPty(sourceId)).toMatch(/^term_/)
  }
)

it('refuses preallocation for a source absent from runtime records', () => {
  const runtime = new Runtime()
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  const before = runtime.snapshot()
  expect(() => runtime.preAllocateHandleForPty(sourceId)).toThrow('source_registration_fenced')
  expect(() => runtime.registerPreAllocatedHandleForPty(sourceId, 'term-old')).toThrow(
    'source_registration_fenced'
  )
  expect(runtime.snapshot()).toEqual(before)
})
