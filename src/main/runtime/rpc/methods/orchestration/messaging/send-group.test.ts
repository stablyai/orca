import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RuntimeTerminalSummary } from '../../../../../../shared/runtime-types'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

// Group addresses mean the sender's Run. The host-wide meaning they had before let one
// coordinator's `@all` reach every terminal in every open project on the machine.
describe('orchestration.send group addresses', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = h
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string | undefined

  function setup(withBoundRun = true): void {
    ;({ db, runtime, ctx, activeRunId } = h.setup(withBoundRun))
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  function makeSummary(
    handle: string,
    opts: Partial<RuntimeTerminalSummary> = {}
  ): RuntimeTerminalSummary {
    return {
      handle,
      ptyId: opts.ptyId ?? handle,
      worktreeId: opts.worktreeId ?? 'wt_default',
      worktreePath: opts.worktreePath ?? '/tmp/wt',
      branch: opts.branch ?? 'main',
      tabId: opts.tabId ?? 'tab_1',
      leafId: opts.leafId ?? handle,
      title: opts.title ?? null,
      connected: opts.connected ?? true,
      writable: opts.writable ?? true,
      lastOutputAt: opts.lastOutputAt ?? null,
      preview: opts.preview ?? '',
      // Why spread: absent `agentIdentity` means unknown, so the helper must be able to
      // produce a summary that genuinely lacks the field.
      ...(opts.agentIdentity ? { agentIdentity: opts.agentIdentity } : {})
    }
  }

  function setupWithTerminals(
    terminals: RuntimeTerminalSummary[],
    agentStatuses?: Record<string, string>
  ): void {
    setup()
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals,
      totalCount: terminals.length,
      truncated: false
    })
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) => {
      if (handle === 'term_coord') {
        return coordinatorPaneKey
      }
      const terminal = terminals.find((candidate) => candidate.handle === handle)
      return terminal ? `${terminal.tabId}:${terminal.leafId}` : null
    })
    vi.spyOn(runtime, 'getAgentStatusForHandle').mockImplementation(
      (handle: string) => agentStatuses?.[handle] ?? null
    )
  }

  /** A live worker Dispatch in `runId` whose terminal is `handle`. */
  function dispatchWorker(handle: string, runId = activeRunId!): string {
    const task = db.createTask({ spec: `work for ${handle}`, runId })
    return createRootDispatch(db, task.id, handle).id
  }

  type GroupReceipt = {
    messages: { to_handle: string; run_id: string; thread_id: string }[]
    recipients: number
    warnings?: { code: string; recipient: string }[]
  }

  it('fans out @all to the live Dispatches of the sender Run and nothing else', async () => {
    // The defect this pins: a coordinator meaning "my three reviewers" reached 126 agents
    // across every open project, because @all enumerated every terminal on the host.
    setupWithTerminals([
      makeSummary('term_coord'),
      makeSummary('term_a'),
      makeSummary('term_b'),
      makeSummary('term_other_project'),
      makeSummary('term_plain_pane')
    ])
    const dispatchA = dispatchWorker('term_a')
    const dispatchB = dispatchWorker('term_b')
    const otherRun = db.createRun({
      objective: 'Another project',
      coordinatorHandle: 'term_other_coord',
      coordinatorPaneKey: 'tab_other:leaf_other'
    })
    dispatchWorker('term_other_project', otherRun.id)

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: '@all',
      subject: 'broadcast'
    })) as GroupReceipt

    expect(result.recipients).toBe(2)
    expect(result.messages.map((m) => m.to_handle).sort()).toEqual(
      [`dispatch:${dispatchA}`, `dispatch:${dispatchB}`].sort()
    )
    expect(result.messages.every((m) => m.run_id === activeRunId)).toBe(true)
    expect(result.warnings).toBeUndefined()
    expect(db.getInbox(100)).toHaveLength(2)
  })

  it('leaves settled Dispatches out of @all', async () => {
    setupWithTerminals([makeSummary('term_coord'), makeSummary('term_a'), makeSummary('term_b')])
    const live = dispatchWorker('term_a')
    db.completeDispatch(dispatchWorker('term_b'))

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: '@all',
      subject: 'only the living'
    })) as GroupReceipt

    expect(result.messages.map((m) => m.to_handle)).toEqual([`dispatch:${live}`])
  })

  it('reaches a Dispatch whose worker terminal is not attached yet', async () => {
    // Durable delivery: the mailbox exists before the terminal does.
    setupWithTerminals([makeSummary('term_coord')])
    const started = db.createStartingWorkerDispatch({
      taskSpec: 'starting worker',
      taskRunId: activeRunId,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: '@all',
      subject: 'early guidance'
    })) as GroupReceipt

    expect(result.messages.map((m) => m.to_handle)).toEqual([`dispatch:${started.dispatch.id}`])
  })

  it('lets a worker address its Run siblings with @all, excluding itself', async () => {
    setupWithTerminals([makeSummary('term_coord'), makeSummary('term_a'), makeSummary('term_b')])
    dispatchWorker('term_a')
    const sibling = dispatchWorker('term_b')

    const result = (await call('orchestration.send', {
      from: 'term_a',
      to: '@all',
      subject: 'sibling ping'
    })) as GroupReceipt

    expect(result.messages.map((m) => m.to_handle)).toEqual([`dispatch:${sibling}`])
  })

  it.each([false, true])(
    'addresses the nested coordinator child Run (explicit scope: %s)',
    async (explicit) => {
      // A nested coordinator is both a worker of its parent Run and the coordinator of the Run it
      // created. It typed `@all` while coordinating, so it means the workers it started. Reaching
      // its siblings instead is the wrong-audience delivery this whole change exists to remove,
      // and it reports success, so the sender never learns its sub-workers heard nothing.
      const nestedPane = 'tab_nested:11111111-1111-4111-8111-111111111111'
      setupWithTerminals([makeSummary('term_coord'), makeSummary('term_nested')])
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_coord' ? coordinatorPaneKey : handle === 'term_nested' ? nestedPane : null
      )
      createRootDispatch(
        db,
        db.createTask({ spec: 'nested', runId: activeRunId }).id,
        'term_nested',
        nestedPane
      )
      const sibling = dispatchWorker('term_sibling')
      const childRun = db.createRun({
        objective: 'child Run',
        coordinatorHandle: 'term_nested',
        coordinatorPaneKey: nestedPane
      })
      const subWorker = dispatchWorker('term_sub', childRun.id)

      const result = (await call('orchestration.send', {
        from: 'term_nested',
        to: '@all',
        ...(explicit ? { run: childRun.id } : {}),
        subject: 'shared context'
      })) as GroupReceipt

      expect(result.messages.map((m) => m.to_handle)).toEqual([`dispatch:${subWorker}`])
      expect(result.messages.map((m) => m.to_handle)).not.toContain(`dispatch:${sibling}`)
    }
  )

  it('names the remote workers it skipped when every live Dispatch is federated', async () => {
    setupWithTerminals([makeSummary('term_coord')])
    const federated = db.createStartingWorkerDispatch({
      taskSpec: 'remote work',
      taskRunId: activeRunId,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      federation: {
        environmentId: 'environment_remote',
        environmentName: 'remote',
        peerFingerprint: 'remote_peer',
        protocolVersion: 3
      }
    })

    // Without the skip explanation the sender is told "no recipients" while three remote
    // workers exist and are each individually addressable.
    await expect(
      call('orchestration.send', { from: 'term_coord', to: '@all', subject: 'pause' })
    ).rejects.toMatchObject({
      code: 'terminal_not_found',
      message: expect.stringContaining(`dispatch:${federated.dispatch.id}`)
    })
  })

  it.each(['@all', '@idle', '@codex'])(
    'rejects %s from a sender in no Run, naming the durable alternatives',
    async (to) => {
      setup(false)
      const listTerminals = vi.spyOn(runtime, 'listTerminals')
      vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === 'term_loner' ? 'tab_loner:leaf_loner' : null
      )

      await expect(
        call('orchestration.send', { from: 'term_loner', to, subject: 'anyone?' })
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: expect.stringMatching(/run:<id> or dispatch:<id>/)
      })

      // No host-wide fallback: the host's terminals are never even enumerated.
      expect(listTerminals).not.toHaveBeenCalled()
      expect(db.getInbox(100)).toHaveLength(0)
    }
  )

  it('rejects @all from a bound coordinator whose Run has no live Dispatch', async () => {
    setupWithTerminals([makeSummary('term_coord'), makeSummary('term_bystander')])

    await expect(
      call('orchestration.send', { from: 'term_coord', to: '@all', subject: 'nobody home' })
    ).rejects.toThrow('No recipients resolved for group address')
    expect(db.getInbox(100)).toHaveLength(0)
  })

  it('continues to fan out status messages to groups', async () => {
    setupWithTerminals([makeSummary('term_coord'), makeSummary('term_a'), makeSummary('term_b')])
    const dispatchA = dispatchWorker('term_a')
    const dispatchB = dispatchWorker('term_b')

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: '@all',
      subject: 'status broadcast',
      type: 'status'
    })) as { messages: { to_handle: string; type: string }[]; recipients: number }

    expect(result.recipients).toBe(2)
    expect(result.messages.map((m) => m.to_handle).sort()).toEqual(
      [`dispatch:${dispatchA}`, `dispatch:${dispatchB}`].sort()
    )
    expect(result.messages.every((m) => m.type === 'status')).toBe(true)
  })

  it('fans out @idle to only the idle Dispatches of the Run', async () => {
    setupWithTerminals(
      [
        makeSummary('term_coord'),
        makeSummary('term_a'),
        makeSummary('term_b'),
        makeSummary('term_idle_elsewhere')
      ],
      { term_a: 'idle', term_b: 'busy', term_idle_elsewhere: 'idle' }
    )
    const idle = dispatchWorker('term_a')
    dispatchWorker('term_b')

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: '@idle',
      subject: 'idle check'
    })) as GroupReceipt

    expect(result.recipients).toBe(1)
    expect(result.messages[0].to_handle).toBe(`dispatch:${idle}`)
  })

  it('fans out an agent name group by host-resolved identity within the Run', async () => {
    setupWithTerminals([
      makeSummary('term_coord', { agentIdentity: 'claude' }),
      makeSummary('term_a', { agentIdentity: 'codex' }),
      makeSummary('term_b', { agentIdentity: 'claude' }),
      makeSummary('term_codex_elsewhere', { agentIdentity: 'codex' })
    ])
    const codex = dispatchWorker('term_a')
    dispatchWorker('term_b')

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: '@codex',
      subject: 'codex only'
    })) as GroupReceipt

    expect(result.recipients).toBe(1)
    expect(result.messages[0].to_handle).toBe(`dispatch:${codex}`)
  })

  it('fans out @droid without claiming a pane whose title merely contains the word', async () => {
    setupWithTerminals([
      makeSummary('term_coord', { agentIdentity: 'codex' }),
      makeSummary('term_b', { agentIdentity: 'droid' }),
      // Why kept: "Android build" contains `droid` as a substring. It was excluded before by
      // whole-token matching and is excluded now because its identity is not droid.
      makeSummary('term_c', { agentIdentity: 'claude', title: 'Android build' })
    ])
    const droid = dispatchWorker('term_b')
    dispatchWorker('term_c')

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: '@droid',
      subject: 'droid only'
    })) as GroupReceipt

    expect(result.recipients).toBe(1)
    expect(result.messages[0].to_handle).toBe(`dispatch:${droid}`)
  })

  it('fans out @cursor without claiming a Claude pane discussing a text cursor', async () => {
    // The original hazard: `@cursor` matched any pane whose TITLE contained "cursor", so a
    // Claude pane titled "Fix the text cursor blink" received Cursor's instructions.
    setupWithTerminals([
      makeSummary('term_coord', { agentIdentity: 'codex' }),
      makeSummary('term_b', { agentIdentity: 'cursor' }),
      makeSummary('term_c', { agentIdentity: 'claude', title: '✳ Fix the text cursor blink' })
    ])
    const cursor = dispatchWorker('term_b')
    dispatchWorker('term_c')

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: '@cursor',
      subject: 'cursor only'
    })) as GroupReceipt

    expect(result.recipients).toBe(1)
    expect(result.messages[0].to_handle).toBe(`dispatch:${cursor}`)
  })

  it('fans out @worktree:<id> to matching worktree terminals, unchanged by Run scoping', async () => {
    setupWithTerminals([
      makeSummary('term_a', { worktreeId: 'wt_1' }),
      makeSummary('term_b', { worktreeId: 'wt_1' }),
      makeSummary('term_c', { worktreeId: 'wt_2' })
    ])

    const result = (await call('orchestration.send', {
      from: 'term_a',
      to: '@worktree:wt_1',
      subject: 'worktree msg'
    })) as GroupReceipt

    expect(result.recipients).toBe(1)
    expect(result.messages[0].to_handle).toBe('term_b')
  })

  it('shares thread_id across fan-out messages', async () => {
    setupWithTerminals([makeSummary('term_coord'), makeSummary('term_a'), makeSummary('term_b')])
    dispatchWorker('term_a')
    dispatchWorker('term_b')

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: '@all',
      subject: 'threaded',
      threadId: 'my_thread'
    })) as GroupReceipt

    expect(result.messages[0].thread_id).toBe('my_thread')
    expect(result.messages[1].thread_id).toBe('my_thread')
  })

  it('generates a shared thread_id when none provided', async () => {
    setupWithTerminals([makeSummary('term_coord'), makeSummary('term_a'), makeSummary('term_b')])
    dispatchWorker('term_a')
    dispatchWorker('term_b')

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: '@all',
      subject: 'auto thread'
    })) as GroupReceipt

    expect(result.messages[0].thread_id).toMatch(/^thread_/)
    expect(result.messages[0].thread_id).toBe(result.messages[1].thread_id)
  })
  it.each(['@all', '@idle'])('does not enumerate host terminals for %s', async (to) => {
    setupWithTerminals([makeSummary('term_coord'), makeSummary('term_a')], { term_a: 'idle' })
    const worker = dispatchWorker('term_a')
    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to,
      subject: 'guidance'
    })) as GroupReceipt
    expect(result.messages.map((m) => m.to_handle)).toEqual([`dispatch:${worker}`])
    expect(runtime.listTerminals).not.toHaveBeenCalled()
  })

  it.each(['run', 'payload'])('does not acquire group membership from %s', async (source) => {
    setupWithTerminals([
      makeSummary('term_coord'),
      makeSummary('term_a'),
      makeSummary('term_loner')
    ])
    const worker = dispatchWorker('term_a')
    const scope =
      source === 'run' ? { run: activeRunId } : { payload: JSON.stringify({ dispatchId: worker }) }
    await expect(
      call('orchestration.send', {
        from: 'term_loner',
        to: '@all',
        subject: 'outside sender',
        ...scope
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(db.getInbox(100)).toHaveLength(0)
    expect(runtime.listTerminals).not.toHaveBeenCalled()
  })

  it('rejects an explicit Run that conflicts with the group audience', async () => {
    setupWithTerminals([makeSummary('term_coord'), makeSummary('term_a')])
    dispatchWorker('term_a')
    const other = db.createRun({
      objective: 'other',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:leaf_other'
    })
    dispatchWorker('term_b', other.id)
    await expect(
      call('orchestration.send', {
        from: 'term_coord',
        to: '@all',
        run: other.id,
        subject: 'explicit scope'
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(db.getInbox(100)).toHaveLength(0)
  })

  it.each(['@codex', '@idle'])(
    '%s resolves a reminted worker handle by its stable pane',
    async (to) => {
      const pane = 'tab_worker:11111111-1111-4111-8111-111111111111'
      setupWithTerminals(
        [
          makeSummary('term_coord'),
          makeSummary('term_new', {
            tabId: 'tab_worker',
            leafId: '11111111-1111-4111-8111-111111111111',
            agentIdentity: 'codex'
          })
        ],
        { term_new: 'idle' }
      )
      vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockImplementation((key) =>
        key === pane ? 'term_new' : null
      )
      const task = db.createTask({ spec: 'surviving worker', runId: activeRunId })
      const dispatch = createRootDispatch(db, task.id, 'term_old', pane)
      const result = (await call('orchestration.send', {
        from: 'term_coord',
        to,
        subject: 'still reachable'
      })) as GroupReceipt
      expect(result.messages.map((m) => m.to_handle)).toEqual([`dispatch:${dispatch.id}`])
    }
  )

  it('delivers a parent broadcast to the mailbox a nested coordinator reads', async () => {
    const nestedPane = 'tab_nested:11111111-1111-4111-8111-111111111111'
    setupWithTerminals([makeSummary('term_coord'), makeSummary('term_nested')])
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : handle === 'term_nested' ? nestedPane : null
    )
    const dispatch = createRootDispatch(
      db,
      db.createTask({ spec: 'nested', runId: activeRunId }).id,
      'term_nested',
      nestedPane
    )
    const child = db.createRun({
      objective: 'child',
      coordinatorHandle: 'term_nested',
      coordinatorPaneKey: nestedPane
    })
    const sent = (await call('orchestration.send', {
      from: 'term_coord',
      to: '@all',
      subject: 'pause all work'
    })) as GroupReceipt
    expect(sent.messages.map((m) => m.to_handle)).toEqual([`run:${child.id}`])
    const checked = (await call('orchestration.check', {
      terminal: 'term_nested',
      peek: true
    })) as { messages: { subject: string }[] }
    expect(checked.messages.map((m) => m.subject)).toEqual(['pause all work'])
    expect(db.getUnreadMessages(`dispatch:${dispatch.id}`)).toHaveLength(0)
  })
  it.each(['@codex', '@idle'])('does not claim remote membership for %s', async (to) => {
    setupWithTerminals(
      [makeSummary('term_coord'), makeSummary('term_codex', { agentIdentity: 'codex' })],
      { term_codex: 'idle' }
    )
    const local = dispatchWorker('term_codex')
    const remote = db.createStartingWorkerDispatch({
      taskSpec: 'remote work',
      taskRunId: activeRunId,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      federation: {
        environmentId: 'remote',
        environmentName: 'remote',
        peerFingerprint: 'peer',
        protocolVersion: 3
      }
    })
    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to,
      subject: 'filtered guidance'
    })) as GroupReceipt
    expect(result.messages.map((m) => m.to_handle)).toEqual([`dispatch:${local}`])
    expect(result.warnings).toBeUndefined()
    expect(db.getUnreadMessages(`dispatch:${remote.dispatch.id}`)).toHaveLength(0)

    db.completeDispatch(local)
    await expect(
      call('orchestration.send', {
        from: 'term_coord',
        to,
        subject: 'no known matches'
      })
    ).rejects.toMatchObject({
      code: 'terminal_not_found',
      message: `No recipients resolved for group address: ${to}`
    })
  })
})
