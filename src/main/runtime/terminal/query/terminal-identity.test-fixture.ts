import '../../orca-runtime-test-mocks.spec'
import { vi, type Mock, type MockInstance } from 'vitest'
import { store, TEST_WORKTREE_ID } from '../../orca-runtime-test-fixtures.spec'
import type { RuntimeSyncWindowGraph } from '../../../../shared/runtime-types'
import type { TerminalIdentitySource } from '../identity/terminal-identity-source'
import type { CrewRuntimeReaders } from '../../orchestration/crew/crew-runtime-watch'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type {
  OrchestrationCompatibilitySshTerminal,
  TerminalHandleRecord
} from '../../runtime-terminal-contracts'
import type { PtyIncarnationHandleRecord } from '../../orca-runtime-core'
import type { CrewChanges } from '../../orchestration/crew/crew-changes'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { TerminalIdentityReadContext } from './terminal-identity-read-context'
import { OrchestrationDb } from '../../orchestration/db'
import { CrewReadModel } from '../../orchestration/crew/crew-read-model'
import { readCrewRuntimeInputs } from '../../orchestration/crew/crew-runtime-watch'

export const LEAF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const PANE = `tab-original:${LEAF}`

type Owner = {
  source: TerminalIdentitySource
  crewReaders: CrewRuntimeReaders
  crewChanges: CrewChanges
  getOrchestrationCompatibilitySshTerminal: (
    handle: string,
    context?: TerminalIdentityReadContext
  ) => OrchestrationCompatibilitySshTerminal | undefined
  runtimeId: string
  rendererGraphEpoch: number
  handles: ReadonlyMap<string, TerminalHandleRecord>
  handleByPtyId: ReadonlyMap<string, string>
  handleByLeafKey: ReadonlyMap<string, string>
  handleByPtyIncarnation: ReadonlyMap<string, PtyIncarnationHandleRecord>
  leaves: ReadonlyMap<string, RuntimeLeafRecord>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  recordPtyWorktree: (
    id: string,
    worktree: string,
    state?: Partial<RuntimePtyWorktreeRecord>
  ) => RuntimePtyWorktreeRecord
  getLivePtyForHandle: (
    handle: string,
    context?: TerminalIdentityReadContext
  ) => { record: TerminalHandleRecord; pty: RuntimePtyWorktreeRecord } | null
  getPtyRecordForPaneKey: (
    pane: string,
    context?: TerminalIdentityReadContext
  ) => RuntimePtyWorktreeRecord | null
  setPtyConnected: (pty: RuntimePtyWorktreeRecord, connected: boolean) => void
  dropDisconnectedPtyRecord: (id: string) => void
  beginGraphReload: (windowId: number) => number
}

class IdentityRuntime extends OrcaRuntimeService {
  identityOwner(): Owner {
    const current = () => this
    return {
      source: this.terminalIdentity,
      get crewReaders() {
        return current().crewRuntimeReaders()
      },
      get runtimeId() {
        return current().runtimeId
      },
      get rendererGraphEpoch() {
        return current().rendererGraphEpoch
      },
      get crewChanges() {
        return current().crewChanges
      },
      get handles() {
        return current().handles
      },
      get handleByPtyId() {
        return current().handleByPtyId
      },
      get handleByLeafKey() {
        return current().handleByLeafKey
      },
      get handleByPtyIncarnation() {
        return current().handleByPtyIncarnation
      },
      get leaves() {
        return current().leaves
      },
      get ptysById() {
        return current().ptysById
      },
      getOrchestrationCompatibilitySshTerminal:
        this.getOrchestrationCompatibilitySshTerminal.bind(this),
      recordPtyWorktree: this.recordPtyWorktree.bind(this),
      getLivePtyForHandle: this.getLivePtyForHandle.bind(this),
      getPtyRecordForPaneKey: this.getPtyRecordForPaneKey.bind(this),
      setPtyConnected: this.setPtyConnected.bind(this),
      dropDisconnectedPtyRecord: this.dropDisconnectedPtyRecord.bind(this),
      beginGraphReload: this.beginGraphReload.bind(this)
    }
  }
}

export function identityFixture(
  deps?: ConstructorParameters<typeof IdentityRuntime>[2],
  runtimeStore: ConstructorParameters<typeof IdentityRuntime>[0] = store
) {
  const runtime = new IdentityRuntime(runtimeStore, undefined, deps)
  const owner = runtime.identityOwner()
  const add = (id: string, handle: string, paneKey = PANE, connected = true) => {
    owner.recordPtyWorktree(id, TEST_WORKTREE_ID, { paneKey, connected })
    owner.source.bindPty(id, handle)
  }
  const stamp = (handle: string, ptyId: string) => {
    owner.source.setHandle(handle, {
      handle,
      runtimeId: owner.runtimeId,
      rendererGraphEpoch: owner.rendererGraphEpoch,
      worktreeId: TEST_WORKTREE_ID,
      tabId: `pty:${ptyId}`,
      leafId: `pty:${ptyId}`,
      ptyId,
      ptyGeneration: 0
    })
  }
  return { runtime, owner, add, stamp }
}

/** Observes the production host generation; each lookup opens fresh finite scratch. */
export function watchIdentityFixture(
  f: ReturnType<typeof identityFixture>,
  captured = true
): {
  acquisition: MockInstance<OrcaRuntimeService['createTerminalIdentityRawInputs']>
  wake: Mock<() => void>
  context: () => TerminalIdentityReadContext | undefined
  pane: (pane: string) => RuntimePtyWorktreeRecord | null
  close: () => void
} {
  const db = new OrchestrationDb(':memory:')
  const acquisition = vi.spyOn(f.runtime, 'createTerminalIdentityRawInputs')
  const model = new CrewReadModel(
    (previous) => readCrewRuntimeInputs(f.owner.crewReaders, db, true, 'schedule-host', previous),
    (wake) => f.owner.crewChanges.subscribe(wake)
  )
  const wake = vi.fn()
  const stop = model.subscribe(wake)
  const context = () => {
    model.read('term_schedule')
    const raw = acquisition.mock.results.at(-1)
    if (!raw || raw.type !== 'return') {
      throw new Error('Expected the production Crew host raw capture')
    }
    return captured ? f.runtime.createTerminalIdentityReadContext(raw.value) : undefined
  }
  return {
    acquisition,
    wake,
    context,
    pane: (pane: string) => f.owner.getPtyRecordForPaneKey(pane, context()),
    close: () => {
      stop()
      acquisition.mockRestore()
      db.close()
    }
  }
}

export function identityGraph(ptyId: string): RuntimeSyncWindowGraph {
  return {
    tabs: [
      {
        tabId: 'tab-original',
        worktreeId: TEST_WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF,
        layout: null
      }
    ],
    leaves: [
      { tabId: 'tab-original', worktreeId: TEST_WORKTREE_ID, leafId: LEAF, paneRuntimeId: 1, ptyId }
    ]
  }
}
