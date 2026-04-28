/* eslint-disable max-lines -- Why: orchestration tests share a mock runtime factory; splitting by method would duplicate 40 lines of setup per file without improving clarity. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { buildRegistry, type RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'

describe('orchestration RPC methods', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    ctx = { runtime }
  }

  afterEach(() => {
    db?.close()
  })

  function findMethod(name: string) {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(name: string, params: Record<string, unknown>) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  it('registers all expected methods', () => {
    const registry = buildRegistry(ORCHESTRATION_METHODS)
    expect(registry.size).toBe(15)
    expect(registry.has('orchestration.send')).toBe(true)
    expect(registry.has('orchestration.check')).toBe(true)
    expect(registry.has('orchestration.reply')).toBe(true)
    expect(registry.has('orchestration.inbox')).toBe(true)
    expect(registry.has('orchestration.taskCreate')).toBe(true)
    expect(registry.has('orchestration.taskList')).toBe(true)
    expect(registry.has('orchestration.taskUpdate')).toBe(true)
    expect(registry.has('orchestration.dispatch')).toBe(true)
    expect(registry.has('orchestration.dispatchShow')).toBe(true)
    expect(registry.has('orchestration.run')).toBe(true)
    expect(registry.has('orchestration.runStop')).toBe(true)
    expect(registry.has('orchestration.gateCreate')).toBe(true)
    expect(registry.has('orchestration.gateResolve')).toBe(true)
    expect(registry.has('orchestration.gateList')).toBe(true)
    expect(registry.has('orchestration.reset')).toBe(true)
  })

  describe('orchestration.send', () => {
    it('sends a message', async () => {
      setup()
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: 'term_b',
        subject: 'hello'
      })) as { message: { id: string; from_handle: string } }

      expect(result.message.id).toMatch(/^msg_/)
      expect(result.message.from_handle).toBe('term_a')
      expect(runtime.deliverPendingMessagesForHandle).toHaveBeenCalledWith('term_b')
    })

    it('rejects missing --to', () => {
      const method = findMethod('orchestration.send')
      expect(() => method.params!.parse({ subject: 'hi' })).toThrow()
    })

    it('rejects missing --subject', () => {
      const method = findMethod('orchestration.send')
      expect(() => method.params!.parse({ to: 'b' })).toThrow()
    })

    it('rejects invalid enum values', () => {
      const method = findMethod('orchestration.send')
      expect(() => method.params!.parse({ to: 'b', subject: 'hi', type: 'typo' })).toThrow()
      expect(() => method.params!.parse({ to: 'b', subject: 'hi', priority: 'medium' })).toThrow()
    })

    function makeSummary(
      handle: string,
      opts: Partial<RuntimeTerminalSummary> = {}
    ): RuntimeTerminalSummary {
      return {
        handle,
        worktreeId: opts.worktreeId ?? 'wt_default',
        worktreePath: opts.worktreePath ?? '/tmp/wt',
        branch: opts.branch ?? 'main',
        tabId: opts.tabId ?? 'tab_1',
        leafId: opts.leafId ?? handle,
        title: opts.title ?? null,
        connected: opts.connected ?? true,
        writable: opts.writable ?? true,
        lastOutputAt: opts.lastOutputAt ?? null,
        preview: opts.preview ?? ''
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
      vi.spyOn(runtime, 'getAgentStatusForHandle').mockImplementation(
        (handle: string) => agentStatuses?.[handle] ?? null
      )
    }

    it('fans out @all to all terminals except sender', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@all',
        subject: 'broadcast'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(2)
      expect(result.messages).toHaveLength(2)
      const recipients = result.messages.map((m) => m.to_handle).sort()
      expect(recipients).toEqual(['term_b', 'term_c'])
    })

    it('fans out @idle to only idle agents', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')], {
        term_b: 'idle',
        term_c: 'busy'
      })

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@idle',
        subject: 'idle check'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('fans out agent name group (@claude) by title match', async () => {
      setupWithTerminals([
        makeSummary('term_a', { title: 'Claude Code' }),
        makeSummary('term_b', { title: 'Claude Code' }),
        makeSummary('term_c', { title: 'Codex' })
      ])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@claude',
        subject: 'claude only'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('fans out @worktree:<id> to matching worktree', async () => {
      setupWithTerminals([
        makeSummary('term_a', { worktreeId: 'wt_1' }),
        makeSummary('term_b', { worktreeId: 'wt_1' }),
        makeSummary('term_c', { worktreeId: 'wt_2' })
      ])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@worktree:wt_1',
        subject: 'worktree msg'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('shares thread_id across fan-out messages', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@all',
        subject: 'threaded',
        threadId: 'my_thread'
      })) as { messages: { thread_id: string }[] }

      expect(result.messages[0].thread_id).toBe('my_thread')
      expect(result.messages[1].thread_id).toBe('my_thread')
    })

    it('generates a shared thread_id when none provided', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@all',
        subject: 'auto thread'
      })) as { messages: { thread_id: string }[] }

      expect(result.messages[0].thread_id).toMatch(/^thread_/)
      expect(result.messages[0].thread_id).toBe(result.messages[1].thread_id)
    })

    it('throws when group resolves to no recipients', async () => {
      setupWithTerminals([makeSummary('term_a')])

      await expect(
        call('orchestration.send', {
          from: 'term_a',
          to: '@all',
          subject: 'nobody home'
        })
      ).rejects.toThrow('No recipients resolved for group address')
    })
  })

  describe('orchestration.check', () => {
    it('returns unread messages for a terminal', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'two' })
      db.insertMessage({ from: 'a', to: 'c', subject: 'other' })

      const result = (await call('orchestration.check', {
        terminal: 'b'
      })) as { messages: unknown[]; count: number }

      expect(result.count).toBe(2)
    })

    it('returns formatted output with --inject', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'test' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        inject: true
      })) as { formatted: string; count: number }

      expect(result.formatted).toContain('Subject: test')
      expect(result.count).toBe(1)
    })

    it('filters by type', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'status', type: 'status' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'done', type: 'worker_done' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        types: 'worker_done'
      })) as { count: number }

      expect(result.count).toBe(1)
    })

    it('rejects invalid type filters', async () => {
      setup()
      await expect(
        call('orchestration.check', {
          terminal: 'b',
          types: 'worker_done,typo'
        })
      ).rejects.toThrow('Invalid --types')
    })
  })

  describe('orchestration.reply', () => {
    it('replies to a message', async () => {
      setup()
      const original = db.insertMessage({ from: 'a', to: 'b', subject: 'question' })

      const result = (await call('orchestration.reply', {
        id: original.id,
        body: 'answer',
        from: 'b'
      })) as { message: { to_handle: string; subject: string; thread_id: string } }

      expect(result.message.to_handle).toBe('a')
      expect(result.message.subject).toBe('Re: question')
      expect(result.message.thread_id).toBe(original.id)
    })

    it('throws on nonexistent message', async () => {
      setup()
      await expect(call('orchestration.reply', { id: 'msg_fake', body: 'nope' })).rejects.toThrow(
        'Message not found'
      )
    })
  })

  describe('orchestration.inbox', () => {
    it('returns all messages', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'c', to: 'd', subject: 'two' })

      const result = (await call('orchestration.inbox', {})) as { count: number }
      expect(result.count).toBe(2)
    })
  })

  describe('orchestration.taskCreate', () => {
    it('creates a task', async () => {
      setup()
      const result = (await call('orchestration.taskCreate', {
        spec: 'implement feature X'
      })) as { task: { id: string; status: string } }

      expect(result.task.id).toMatch(/^task_/)
      expect(result.task.status).toBe('ready')
    })

    it('creates a task with deps', async () => {
      setup()
      const t1 = db.createTask({ spec: 'first' })

      const result = (await call('orchestration.taskCreate', {
        spec: 'second',
        deps: JSON.stringify([t1.id])
      })) as { task: { status: string } }

      expect(result.task.status).toBe('pending')
    })

    it('rejects invalid deps JSON', async () => {
      setup()
      await expect(
        call('orchestration.taskCreate', { spec: 'bad', deps: 'not-json' })
      ).rejects.toThrow('Invalid --deps')
    })
  })

  describe('orchestration.taskList', () => {
    it('lists all tasks', async () => {
      setup()
      db.createTask({ spec: 'a' })
      db.createTask({ spec: 'b' })

      const result = (await call('orchestration.taskList', {})) as { count: number }
      expect(result.count).toBe(2)
    })

    it('filters by status', async () => {
      setup()
      db.createTask({ spec: 'a' })
      const t2 = db.createTask({ spec: 'b' })
      db.updateTaskStatus(t2.id, 'completed')

      const result = (await call('orchestration.taskList', {
        status: 'ready'
      })) as { count: number }
      expect(result.count).toBe(1)
    })

    it('rejects invalid status filters', () => {
      const method = findMethod('orchestration.taskList')
      expect(() => method.params!.parse({ status: 'done-ish' })).toThrow()
    })
  })

  describe('orchestration.taskUpdate', () => {
    it('updates task status', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.taskUpdate', {
        id: task.id,
        status: 'completed',
        result: '{"ok": true}'
      })) as { task: { status: string; result: string } }

      expect(result.task.status).toBe('completed')
      expect(result.task.result).toBe('{"ok": true}')
    })

    it('completion frees the active dispatch context', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      db.createDispatchContext(task.id, 'term_a')

      await call('orchestration.taskUpdate', {
        id: task.id,
        status: 'completed'
      })

      expect(db.getActiveDispatchForTerminal('term_a')).toBeUndefined()
    })

    it('throws on nonexistent task', async () => {
      setup()
      await expect(
        call('orchestration.taskUpdate', { id: 'task_fake', status: 'completed' })
      ).rejects.toThrow('Task not found')
    })
  })

  describe('orchestration.dispatch', () => {
    it('dispatches a task to a terminal', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a'
      })) as { dispatch: { task_id: string; status: string } }

      expect(result.dispatch.task_id).toBe(task.id)
      expect(result.dispatch.status).toBe('dispatched')
    })

    it('rejects dispatch for a pending task', async () => {
      setup()
      const parent = db.createTask({ spec: 'parent' })
      const child = db.createTask({ spec: 'child', deps: [parent.id] })

      await expect(
        call('orchestration.dispatch', {
          task: child.id,
          to: 'term_a'
        })
      ).rejects.toThrow('only ready tasks can be dispatched')
    })

    it('rolls back active dispatch when injection fails', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      vi.spyOn(runtime, 'sendTerminal').mockRejectedValue(new Error('terminal_not_writable'))

      await expect(
        call('orchestration.dispatch', {
          task: task.id,
          to: 'term_a',
          inject: true
        })
      ).rejects.toThrow('terminal_not_writable')

      expect(db.getTask(task.id)?.status).toBe('ready')
      expect(db.getActiveDispatchForTerminal('term_a')).toBeUndefined()
    })

    it('uses caller-provided dev mode for injected preamble', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      const send = vi.spyOn(runtime, 'sendTerminal').mockResolvedValue({
        handle: 'term_a',
        accepted: true,
        bytesWritten: 1
      })

      await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a',
        inject: true,
        devMode: true
      })

      expect(send.mock.calls[0]?.[1].text).toContain('orca-dev orchestration send')
    })

    it('rejects inject to terminal without recognized agent', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(false)

      await expect(
        call('orchestration.dispatch', {
          task: task.id,
          to: 'term_a',
          inject: true
        })
      ).rejects.toThrow('no recognized agent detected')
    })

    it('rejects dispatch to occupied terminal', async () => {
      setup()
      const t1 = db.createTask({ spec: 'first' })
      const t2 = db.createTask({ spec: 'second' })
      db.createDispatchContext(t1.id, 'term_a')

      await expect(call('orchestration.dispatch', { task: t2.id, to: 'term_a' })).rejects.toThrow(
        /already has an active dispatch/
      )
    })
  })

  describe('orchestration.dispatchShow', () => {
    it('shows dispatch context for a task', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      db.createDispatchContext(task.id, 'term_a')

      const result = (await call('orchestration.dispatchShow', {
        task: task.id
      })) as { dispatch: { task_id: string } | null }

      expect(result.dispatch?.task_id).toBe(task.id)
    })

    it('returns null for unknown task', async () => {
      setup()
      const result = (await call('orchestration.dispatchShow', {
        task: 'task_fake'
      })) as { dispatch: null }

      expect(result.dispatch).toBeNull()
    })
  })

  describe('orchestration.gateCreate', () => {
    it('creates a decision gate and blocks the task', async () => {
      setup()
      const task = db.createTask({ spec: 'needs approval' })

      const result = (await call('orchestration.gateCreate', {
        task: task.id,
        question: 'Proceed with migration?',
        options: JSON.stringify(['yes', 'no', 'defer'])
      })) as { gate: { id: string; task_id: string; status: string } }

      expect(result.gate.id).toMatch(/^gate_/)
      expect(result.gate.task_id).toBe(task.id)
      expect(result.gate.status).toBe('pending')

      const updated = db.getTask(task.id)
      expect(updated?.status).toBe('blocked')
    })

    it('rejects invalid options JSON', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      await expect(
        call('orchestration.gateCreate', {
          task: task.id,
          question: 'ok?',
          options: 'not-json'
        })
      ).rejects.toThrow('Invalid --options')
    })

    it('rejects options that are not string arrays', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      await expect(
        call('orchestration.gateCreate', {
          task: task.id,
          question: 'ok?',
          options: JSON.stringify(['yes', 1])
        })
      ).rejects.toThrow('Invalid --options')
    })
  })

  describe('orchestration.gateResolve', () => {
    it('resolves a gate and unblocks the task', async () => {
      setup()
      const task = db.createTask({ spec: 'needs approval' })
      const gate = db.createGate({ taskId: task.id, question: 'Proceed?' })

      const result = (await call('orchestration.gateResolve', {
        id: gate.id,
        resolution: 'yes'
      })) as { gate: { id: string; status: string; resolution: string } }

      expect(result.gate.status).toBe('resolved')
      expect(result.gate.resolution).toBe('yes')

      const updated = db.getTask(task.id)
      expect(updated?.status).toBe('ready')
    })

    it('throws on nonexistent gate', async () => {
      setup()
      await expect(
        call('orchestration.gateResolve', { id: 'gate_fake', resolution: 'yes' })
      ).rejects.toThrow('Gate not found')
    })
  })

  describe('orchestration.gateList', () => {
    it('lists all gates', async () => {
      setup()
      const t1 = db.createTask({ spec: 'a' })
      const t2 = db.createTask({ spec: 'b' })
      db.createGate({ taskId: t1.id, question: 'q1' })
      db.createGate({ taskId: t2.id, question: 'q2' })

      const result = (await call('orchestration.gateList', {})) as { count: number }
      expect(result.count).toBe(2)
    })

    it('filters by status', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const gate = db.createGate({ taskId: task.id, question: 'q' })
      db.resolveGate(gate.id, 'yes')

      const result = (await call('orchestration.gateList', {
        status: 'resolved'
      })) as { count: number }
      expect(result.count).toBe(1)
    })

    it('rejects invalid status filters', () => {
      const method = findMethod('orchestration.gateList')
      expect(() => method.params!.parse({ status: 'closed' })).toThrow()
    })
  })

  describe('orchestration.reset', () => {
    it('resets all state', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'test' })
      db.createTask({ spec: 'work' })

      const result = (await call('orchestration.reset', { all: true })) as { reset: string }
      expect(result.reset).toBe('all')
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(0)
    })

    it('resets tasks only', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'test' })
      db.createTask({ spec: 'work' })

      await call('orchestration.reset', { tasks: true })
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(0)
    })

    it('resets messages only', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'test' })
      db.createTask({ spec: 'work' })

      await call('orchestration.reset', { messages: true })
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(1)
    })
  })
})
