import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../construction/test-context/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'
import type { RuntimeNotifier } from '../../../client/events/runtime-notifier-contract'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeResolvedWorktreeCache } from '../../../workspaces/catalog/runtime-resolved-worktree-cache'
import type { ResolvedWorktree } from '../../../workspaces/catalog/runtime-worktree-path-identity'

const paneKey = 'tab:11111111-1111-4111-8111-111111111111'

it.each([100, 1_000])(
  'a held-mail receipt for a manually slept agent reads none of %i published workspaces',
  async (published) => {
    const db = new OrchestrationDb(':memory:')
    const record: SleepingAgentSessionRecord = {
      paneKey,
      tabId: 'tab',
      worktreeId: `folder:workspace-${published - 1}`,
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'conversation' },
      prompt: '',
      state: 'done',
      origin: 'worktree-sleep',
      restoreOnTabOpenOnly: true,
      capturedAt: 1,
      updatedAt: 1
    }
    const session = {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: { [paneKey]: record }
    }
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getWorkspaceSession: () => session,
        getWorkspaceSessionHostIds: () => ['local']
      })
    )
    const resumeSleepingAgents = async () => true
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a receipt calls no notifier member that returns a value.
    const notifier = new Proxy(
      {},
      { get: (_target, key) => (key === 'resumeSleepingAgents' ? resumeSleepingAgents : vi.fn()) }
    ) as RuntimeNotifier
    let rowReads = 0
    const worktrees = Array.from({ length: published }, (_, index) => {
      const id = `folder:workspace-${index}`
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a receipt reads only a row's id, host and name.
      return {
        get id() {
          rowReads += 1
          return id
        },
        hostId: 'local',
        displayName: `Workspace ${index}`
      } as unknown as ResolvedWorktree
    })
    try {
      runtime.setNotifier(notifier)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.setOrchestrationDb(db)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the published catalog is the population under test.
      const catalog = (runtime as unknown as { resolvedWorktrees: RuntimeResolvedWorktreeCache })
        .resolvedWorktrees
      await catalog.getSnapshot(async () => ({ worktrees, platformByRepoId: new Map() }), 60_000, 0)
      const run = db.createRun({
        objective: 'Manual sleep',
        coordinatorHandle: 'term_asleep',
        coordinatorPaneKey: paneKey
      })
      const mailbox = `run:${run.id}`
      db.insertMessage({ runId: run.id, from: 'worker', to: mailbox, subject: 'held' })
      runtime.deliverPendingMessagesForHandle(mailbox)
      await new Promise<void>((resolve) => setImmediate(resolve))
      rowReads = 0

      for (let receipt = 0; receipt < 10; receipt += 1) {
        expect(await runtime.readSleepingMailHold(mailbox)).toMatchObject({
          kind: 'asleep',
          openTab: true,
          workspaceName: undefined
        })
      }
      // The tab-only wording names no workspace, so no published row is read.
      expect(rowReads).toBe(0)
    } finally {
      runtime.setNotifier(null)
      db.close()
    }
  }
)
