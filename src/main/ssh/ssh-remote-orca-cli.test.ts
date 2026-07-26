import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/host/app'
  }
}))
vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/host/user-data'
}))

import { OrchestrationDb } from '../runtime/orchestration/db'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { HostCliPassthroughOptions } from './ssh-remote-cli-host-passthrough'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

// Why: pointing the passthrough at a missing CLI entry forces the legacy
// in-process fallback, which is what these dispatch tests exercise.
const LEGACY_FALLBACK_OPTIONS: HostCliPassthroughOptions = {
  execPath: '/host/electron',
  cliEntryPath: '/host/app/out/cli/index.js',
  userDataPath: '/host/user-data',
  entryExists: () => false
}

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn(), on: vi.fn() }
  child.kill = vi.fn()
  return child
}

describe('runRemoteOrcaCli', () => {
  function createRuntime() {
    const messages: {
      id: string
      from_handle: string
      to_handle: string
      subject: string
      body?: string
      read_at: string | null
    }[] = []
    let nextMessage = 1
    const db = {
      insertMessage: vi.fn(
        (message: { from: string; to: string; subject: string; body?: string }) => {
          const row = {
            id: `msg_${nextMessage++}`,
            from_handle: message.from,
            to_handle: message.to,
            subject: message.subject,
            body: message.body,
            read_at: null
          }
          messages.push(row)
          return row
        }
      ),
      getUnreadMessages: vi.fn((handle: string) =>
        messages.filter((message) => message.to_handle === handle && message.read_at === null)
      ),
      getAllMessagesForHandle: vi.fn((handle: string) =>
        messages.filter((message) => message.to_handle === handle)
      ),
      markAsRead: vi.fn((ids: string[]) => {
        for (const message of messages) {
          if (ids.includes(message.id)) {
            message.read_at = new Date(0).toISOString()
          }
        }
      })
    }
    const runtime = {
      getRuntimeId: () => 'runtime-test',
      getStatus: () => ({
        runtimeId: 'runtime-test',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 1,
        liveLeafCount: 1
      }),
      getOrchestrationDb: () => db,
      getTerminalPaneKey: () => null,
      deliverPendingMessagesForHandle: vi.fn(),
      notifyMessageArrived: vi.fn(),
      linearIssueContext: vi.fn(async (request: unknown) => ({
        request,
        issue: {
          id: 'issue-1',
          identifier: 'ENG-123',
          title: 'Fix thing',
          url: 'https://linear.app/acme/issue/ENG-123',
          labels: []
        },
        meta: {
          requested: {
            current: true,
            include: {
              comments: true,
              children: true,
              attachments: true,
              relations: true,
              activity: true
            },
            depth: 2
          },
          resolved: {
            id: 'issue-1',
            identifier: 'ENG-123',
            workspaceId: 'workspace-1',
            workspaceName: 'Acme'
          },
          partial: false,
          includeErrors: [],
          sections: {}
        }
      })),
      linearSearchForAgents: vi.fn(async (request: unknown) => ({
        request,
        issues: [],
        meta: { query: 'auth bug', limit: 5, returned: 0, limitReached: false }
      }))
    } as unknown as OrcaRuntimeService
    return { runtime, db }
  }

  it('uses the remote ORCA_TERMINAL_HANDLE as orchestration sender identity', async () => {
    const { runtime, db } = createRuntime()

    const result = await runRemoteOrcaCli(
      runtime,
      {
        argv: ['orchestration', 'send', '--to', 'term_windows', '--subject', 'ping', '--json'],
        cwd: '/home/alice/repo',
        env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
      },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as { ok: boolean }
    expect(payload.ok).toBe(true)
    expect(db.getUnreadMessages('term_windows')[0]?.from_handle).toBe('term_ssh')
  })

  it('forwards remote pane identity through the legacy orchestration fallback', async () => {
    const { runtime, db } = createRuntime()

    const result = await runRemoteOrcaCli(
      runtime,
      {
        argv: ['orchestration', 'send', '--to', 'term_windows', '--subject', 'ping', '--json'],
        cwd: '/home/alice/repo',
        env: {
          ORCA_TERMINAL_HANDLE: 'term_ssh',
          ORCA_PANE_KEY: 'tab_ssh:leaf_ssh'
        }
      },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(result.exitCode).toBe(0)
    expect(db.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ senderPaneKey: 'tab_ssh:leaf_ssh' })
    )
  })

  it('returns a non-zero status for lifecycle rejection through the legacy fallback', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    const task = db.createTask({ spec: 'remote work' })
    const dispatch = db.createDispatchContext(task.id, 'term_ssh', 'tab_owner:leaf_owner')

    try {
      const result = await runRemoteOrcaCli(
        runtime,
        {
          argv: [
            'orchestration',
            'send',
            '--from',
            'term_ssh',
            '--to',
            'term_coord',
            '--subject',
            'Done',
            '--type',
            'worker_done',
            '--payload',
            JSON.stringify({ taskId: task.id, dispatchId: dispatch.id }),
            '--json'
          ],
          cwd: '/home/alice/repo',
          env: { ORCA_PANE_KEY: 'tab_foreign:leaf_foreign' }
        },
        LEGACY_FALLBACK_OPTIONS
      )

      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        result: {
          message: { type: 'worker_done', subject: 'Rejected worker_done: Done' },
          lifecycle: { action: 'rejected', code: 'sender_not_assignee' }
        }
      })
      expect(db.getTask(task.id)?.status).toBe('dispatched')
    } finally {
      db.close()
    }
  })

  it('preserves structured lifecycle payload flags through the legacy fallback', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    const task = db.createTask({ spec: 'remote work' })
    const dispatch = db.createDispatchContext(task.id, 'term_ssh', 'tab_owner:leaf_owner')

    try {
      const result = await runRemoteOrcaCli(
        runtime,
        {
          argv: [
            'orchestration',
            'send',
            '--to',
            'term_coord',
            '--subject',
            'Done',
            '--type',
            'worker_done',
            '--task-id',
            task.id,
            '--dispatch-id',
            dispatch.id,
            '--files-modified',
            'src/a.ts, src/b.ts',
            '--json'
          ],
          cwd: '/home/alice/repo',
          env: {
            ORCA_TERMINAL_HANDLE: 'term_ssh',
            ORCA_PANE_KEY: 'tab_owner:leaf_owner'
          }
        },
        LEGACY_FALLBACK_OPTIONS
      )

      expect(result.exitCode).toBe(0)
      expect(db.getTask(task.id)).toMatchObject({
        status: 'completed',
        result: expect.stringContaining('src/a.ts')
      })
    } finally {
      db.close()
    }
  })

  it('rejects identity-less lifecycle sends in the legacy fallback', async () => {
    const { runtime, db } = createRuntime()

    const result = await runRemoteOrcaCli(
      runtime,
      {
        argv: [
          'orchestration',
          'send',
          '--to',
          'term_coord',
          '--subject',
          'Done',
          '--type',
          'worker_done',
          '--json'
        ],
        cwd: '/home/alice/repo',
        env: {}
      },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'no_active_sender_terminal' }
    })
    expect(db.insertMessage).not.toHaveBeenCalled()
  })

  it('rejects mixed raw and structured payload flags in the legacy fallback', async () => {
    const { runtime, db } = createRuntime()

    const result = await runRemoteOrcaCli(
      runtime,
      {
        argv: [
          'orchestration',
          'send',
          '--from',
          'term_ssh',
          '--to',
          'term_coord',
          '--subject',
          'Done',
          '--payload',
          '{"taskId":"task_1"}',
          '--task-id',
          'task_1',
          '--json'
        ],
        cwd: '/home/alice/repo',
        env: {}
      },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: expect.stringContaining('structured payload') }
    })
    expect(db.insertMessage).not.toHaveBeenCalled()
  })

  it('accepts equals-style orchestration flags in the remote shim', async () => {
    const { runtime, db } = createRuntime()

    const result = await runRemoteOrcaCli(
      runtime,
      {
        argv: [
          'orchestration',
          'send',
          '--to=term_windows',
          '--subject=ping',
          '--body=--literal-body',
          '--json'
        ],
        cwd: '/home/alice/repo',
        env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
      },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as { ok: boolean }
    expect(payload.ok).toBe(true)
    const message = db.getUnreadMessages('term_windows')[0]
    expect(message?.from_handle).toBe('term_ssh')
    expect(message?.body).toBe('--literal-body')
  })

  it('uses the remote ORCA_TERMINAL_HANDLE as orchestration check identity', async () => {
    const { runtime, db } = createRuntime()
    db.insertMessage({
      from: 'term_windows',
      to: 'term_ssh',
      subject: 'pong',
      body: 'hello'
    })

    const result = await runRemoteOrcaCli(
      runtime,
      {
        argv: ['orchestration', 'check', '--all', '--json'],
        cwd: '/home/alice/repo',
        env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
      },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      result: { count: number; messages: { subject: string }[] }
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.count).toBe(1)
    expect(payload.result.messages[0]?.subject).toBe('pong')
  })

  it('routes previously-unsupported commands through the full host CLI', async () => {
    const { runtime } = createRuntime()
    const child = createFakeChild()
    const spawn = vi.fn(() => child)

    const resultPromise = runRemoteOrcaCli(
      runtime,
      {
        argv: ['worktree', 'create', '--repo', 'orca', '--branch', 'fix/x', '--json'],
        cwd: '/home/alice/repo',
        env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
      },
      {
        execPath: '/host/electron',
        cliEntryPath: '/host/app/out/cli/index.js',
        userDataPath: '/host/user-data',
        entryExists: () => true,
        spawn: spawn as never
      }
    )

    await Promise.resolve()
    child.stdout.emit('data', Buffer.from('{"ok":true}\n'))
    child.emit('close', 0)

    const result = await resultPromise
    expect(result).toEqual({ stdout: '{"ok":true}\n', stderr: '', exitCode: 0 })
    const [, args] = spawn.mock.calls[0] as unknown as [string, string[]]
    expect(args).toEqual([
      '/host/app/out/cli/index.js',
      'worktree',
      'create',
      '--repo',
      'orca',
      '--branch',
      'fix/x',
      '--json'
    ])
  })

  it('rejects host-interactive commands with a targeted error instead of bridging them', async () => {
    const { runtime } = createRuntime()
    const spawn = vi.fn()

    const result = await runRemoteOrcaCli(
      runtime,
      { argv: ['serve'], cwd: '/home/alice', env: {} },
      { ...LEGACY_FALLBACK_OPTIONS, spawn: spawn as never }
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('orca serve')
    expect(result.stderr).toContain('SSH relay bridge')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports host-interactive command errors as JSON envelopes with --json', async () => {
    const { runtime } = createRuntime()

    const result = await runRemoteOrcaCli(
      runtime,
      { argv: ['serve', '--json'], cwd: '/home/alice', env: {} },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(result.exitCode).toBe(1)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      error: { code: string }
    }
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('unsupported_over_ssh')
  })

  it('explains the root cause when falling back and the command is not in the legacy switch', async () => {
    const { runtime } = createRuntime()

    const result = await runRemoteOrcaCli(
      runtime,
      { argv: ['worktree', 'list'], cwd: '/home/alice', env: {} },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Unsupported SSH Orca CLI command: worktree list')
    expect(result.stderr).toContain('full Orca CLI bridge unavailable')
  })

  it('does not parse Android --activity values as Linear boolean flags', async () => {
    const { runtime } = createRuntime()

    const result = await runRemoteOrcaCli(
      runtime,
      {
        argv: ['emulator', 'launch', 'com.acme.app', '--activity', '.MainActivity'],
        cwd: '/home/alice',
        env: {}
      },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      'Unsupported SSH Orca CLI command: emulator launch com.acme.app'
    )
    expect(result.stderr).not.toContain('com.acme.app .MainActivity')
  })
})
