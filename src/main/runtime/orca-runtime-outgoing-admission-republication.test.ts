import { expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { fenceOutgoingPtyRegistrations } from './outgoing-pty-registration-fence'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import type { RuntimeSyncWindowGraph } from '../../shared/runtime-types'

const sourceId = toAppSshPtyId('source', 'pty')
const leafId = '11111111-1111-4111-8111-111111111111'

class Runtime extends OrcaRuntimeService {
  issueLeafHandles() {
    for (const leaf of this.leaves.values()) {
      this.issueHandle(leaf)
    }
  }
}

function fixture(preallocated = true) {
  const runtime = new Runtime()
  runtime.registerPty(sourceId, 'folder:source', 'source', {
    tabId: 'source',
    leafId,
    incarnationId: 'source-incarnation'
  })
  if (preallocated) {
    runtime.preAllocateHandleForPty(sourceId)
  }
  const graph: RuntimeSyncWindowGraph = {
    tabs: [
      {
        tabId: 'source',
        worktreeId: 'folder:source',
        title: 'Terminal',
        activeLeafId: leafId,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'source',
        worktreeId: 'folder:source',
        leafId,
        paneRuntimeId: 1,
        ptyId: sourceId
      }
    ]
  }
  runtime.syncWindowGraph(1, graph)
  runtime.issueLeafHandles()
  // The first publication promotes graph readiness; bind after writable state settles.
  runtime.syncWindowGraph(1, structuredClone(graph))
  const admission = runtime.bindOutgoingSshPtyCatalogSurfaces('source')
  admission.assertCurrent()
  return { runtime, graph, admission }
}

it.each([true, false])(
  'keeps a live source admissible across identical republication (preallocated=%s)',
  (preallocated) => {
    const { runtime, graph, admission } = fixture(preallocated)
    runtime.syncWindowGraph(1, structuredClone(graph))
    expect(() => admission.assertCurrent()).not.toThrow()
  }
)

it('an existing cleanup fence preserves exact admission against renderer republication', () => {
  const { runtime, graph, admission } = fixture()
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  expect(() => runtime.syncWindowGraph(1, structuredClone(graph))).toThrow(
    'orcad_outgoing_source_graph_publication_fenced'
  )
  expect(() => admission.assertCurrent()).not.toThrow()
})

it('refuses admission when renderer publication rebinds the pane to another PTY', () => {
  const { runtime, graph, admission } = fixture()
  const rebound = structuredClone(graph)
  rebound.leaves[0].ptyId = toAppSshPtyId('source', 'replacement')
  runtime.syncWindowGraph(1, rebound)
  expect(() => admission.assertCurrent()).toThrow('orcad_outgoing_source_graph_changed')
})

it('retains source admission when republishing after terminal output populates wait state', async () => {
  const { runtime, graph } = fixture()
  await runtime.acceptPtyDataBounded(sourceId, 'shell output\r\n', Date.now()).completion
  const admission = runtime.bindOutgoingSshPtyCatalogSurfaces('source')
  runtime.syncWindowGraph(1, structuredClone(graph))
  expect(() => admission.assertCurrent()).not.toThrow()
})
