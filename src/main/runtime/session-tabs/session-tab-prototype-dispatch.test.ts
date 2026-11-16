import { describe, expect, it } from 'vitest'

import { OrcaRuntimeService } from '../orca-runtime'
import '../../native-chat/agent-session-wire/host/structured-agent-session-registry'

class GraphRuntime extends OrcaRuntimeService {
  get graphTabs() {
    return this.tabs
  }
  get graphLeaves() {
    return this.leaves
  }
  get graphLeavesByPtyId() {
    return this.leavesByPtyId
  }
  get graphAvailability() {
    return this.graphStatus
  }
  get graphEpoch() {
    return this.rendererGraphEpoch
  }
  get detachedLeaves() {
    return this.detachedPreAllocatedLeaves
  }
  get syncCallbacks() {
    return this.graphSyncCallbacks
  }
}

const graph = {
  tabs: [{ tabId: 'tab', worktreeId: 'workspace', activeLeafId: 'leaf', layout: null, title: '' }],
  leaves: [
    {
      tabId: 'tab',
      worktreeId: 'workspace',
      leafId: 'leaf',
      paneRuntimeId: 1,
      ptyId: 'pty',
      paneTitle: null
    }
  ]
}

describe('runtime graph ownership', () => {
  it('shares detached preallocated leaves with terminal identity during renderer reload', async () => {
    const runtime = new GraphRuntime()
    const handle = runtime.preAllocateHandleForPty('pty')
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, graph)
    const leaf = runtime.graphLeaves.get('tab::leaf')

    runtime.markRendererReloading(1)

    expect(runtime.detachedLeaves.get('pty')).toBe(leaf)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.onPtyData('pty', 'after omitted leaf\n', 100)
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      tail: ['after omitted leaf']
    })
  })
})
