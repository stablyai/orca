import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

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
            include: { comments: true, children: true, attachments: true, relations: true },
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

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['orchestration', 'send', '--to', 'term_windows', '--subject', 'ping', '--json'],
      cwd: '/home/alice/repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as { ok: boolean }
    expect(payload.ok).toBe(true)
    expect(db.getUnreadMessages('term_windows')[0]?.from_handle).toBe('term_ssh')
  })

  it('accepts equals-style orchestration flags in the remote shim', async () => {
    const { runtime, db } = createRuntime()

    const result = await runRemoteOrcaCli(runtime, {
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
    })

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

    const result = await runRemoteOrcaCli(runtime, {
      argv: ['orchestration', 'check', '--all', '--json'],
      cwd: '/home/alice/repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      result: { count: number; messages: { subject: string }[] }
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.count).toBe(1)
    expect(payload.result.messages[0]?.subject).toBe('pong')
  })
})
