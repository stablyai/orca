import { expect, it } from 'vitest'
import { identityFixture, identityGraph, LEAF, PANE } from '../query/terminal-identity.test-fixture'
import { TEST_WORKTREE_ID } from '../../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'

it('retains pane-issued process identity across reload with exact first-match and SSH precedence in either context', () => {
  for (const captured of [false, true]) {
    const f = identityFixture()
    f.runtime.registerPty('retained-process', TEST_WORKTREE_ID, null, {
      tabId: 'tab-original',
      leafId: LEAF,
      incarnationId: 'original'
    })
    f.runtime.attachWindow(1)
    f.runtime.syncWindowGraph(1, identityGraph('retained-process'))
    const handle = f.runtime.getTerminalHandleForPaneKey(PANE)!
    expect(handle).toMatch(/^term_/)
    expect(f.owner.handleByPtyId.has('retained-process')).toBe(false)
    expect(f.owner.handleByPtyIncarnation.get('retained-process')?.handle).toBe(handle)
    expect(f.runtime.getTerminalProcessIncarnation(handle)).toBe('retained-process:original')
    const fence = f.runtime.markRendererReloading(1)
    expect(fence).not.toBeNull()
    expect(f.owner.handles.has(handle)).toBe(false)
    expect(f.owner.handleByLeafKey.size).toBe(0)
    const attachment = f.runtime.registerOrchestrationCompatibilitySshAttachment(
      'remote',
      'connection',
      {
        handle,
        paneKey: PANE,
        processIncarnation: 'ssh-process'
      }
    )
    const read = () =>
      f.runtime.getTerminalProcessIncarnation(
        handle,
        captured ? f.runtime.createTerminalIdentityReadContext() : undefined
      )
    try {
      expect(read()).toBe('retained-process:original')
      const pty = f.owner.ptysById.get('retained-process')!
      f.owner.source.setPtyConnected(pty, false)
      expect(read()).toBe('retained-process:original')
      f.owner.source.setPtyIncarnationId(pty, 'replacement')
      expect(read()).toBe('ssh-process')
      f.owner.source.setIncarnation('retained-process', {
        handle,
        incarnationId: null,
        leafKey: 'first'
      })
      f.owner.recordPtyWorktree('later-valid', TEST_WORKTREE_ID, { incarnationId: 'later' })
      f.owner.source.setIncarnation('later-valid', {
        handle,
        incarnationId: 'later',
        leafKey: 'later'
      })
      expect(read()).toBe('ssh-process')
      f.owner.source.setIncarnation('retained-process', {
        handle,
        incarnationId: 'stale',
        leafKey: 'first'
      })
      expect(read()).toBe('ssh-process')
      f.owner.source.removeIncarnation('retained-process')
      // No pane shows later-valid, so its alias answers only exit waits.
      expect(read()).toBe('ssh-process')
      f.owner.source.setIncarnation('retained-process', {
        handle,
        incarnationId: 'replacement',
        leafKey: 'first'
      })
      expect(read()).toBe('ssh-process')
      f.owner.source.removeIncarnation('later-valid')
      expect(read()).toBe('retained-process:replacement')
      f.owner.source.removeIncarnation('retained-process')
      expect(read()).toBe('ssh-process')
      f.runtime.releaseOrchestrationCompatibilitySshAttachment(attachment.attachmentId)
      expect(read()).toBeNull()
    } finally {
      f.runtime.releaseOrchestrationCompatibilitySshAttachment(attachment.attachmentId)
      if (fence) {
        f.runtime.markRendererReloadCancelled(1, fence)
      }
    }
  }
})

it('keeps the displayed leaf worker ahead of retained PTYs after a dispatch refresh', () => {
  const f = identityFixture()
  const db = new OrchestrationDb(':memory:')
  try {
    f.add('retained', 'old-worker', PANE, false)
    f.stamp('old-worker', 'retained')
    f.runtime.registerPty('current', TEST_WORKTREE_ID, null, {
      tabId: 'tab-original',
      leafId: LEAF,
      incarnationId: 'current'
    })
    f.runtime.attachWindow(1)
    f.runtime.syncWindowGraph(1, identityGraph('current'))
    const current = f.runtime.getTerminalHandleForPaneKey(PANE)!
    const run = db.createRun({
      objective: 'Displayed worker',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const retained = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'Old worker' }).id,
      assigneeHandle: 'old-worker',
      assigneePaneKey: 'tab-retained:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      creator: { kind: 'system' },
      maxDepth: 99
    })
    const displayed = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'Current worker' }).id,
      assigneeHandle: current,
      assigneePaneKey: PANE,
      creator: { kind: 'system' },
      maxDepth: 99
    })
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_pane_key = ? WHERE id = ?')
      .run(PANE, retained.id)
    f.runtime.setOrchestrationDb(db)
    expect(
      f.runtime.syncWindowGraph(1, identityGraph('current')).agentOrchestrationByPaneKey?.[PANE]
        ?.dispatchId
    ).toBe(displayed.id)
    f.owner.source.setPtyConnected(f.owner.ptysById.get('current')!, false)
    db.db.prepare('UPDATE dispatch_contexts SET failure_count = 1 WHERE id = ?').run(retained.id)
    expect(
      f.runtime.syncWindowGraph(1, identityGraph('current')).agentOrchestrationByPaneKey?.[PANE]
        ?.dispatchId
    ).toBe(displayed.id)
    expect(f.runtime.getAgentStatusOrchestrationContextForPaneKey(PANE)?.dispatchId).toBe(
      displayed.id
    )
  } finally {
    db.close()
  }
})
