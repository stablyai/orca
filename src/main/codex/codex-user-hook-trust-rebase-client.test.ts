import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexAppServerSession from './codex-app-server-session'
import type { CodexAppServerRpc } from './codex-app-server-session'

const requestRpcMock = vi.hoisted(() => vi.fn<CodexAppServerRpc['request']>())
vi.mock('./codex-app-server-session', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexAppServerSession>()
  return {
    ...actual,
    runCodexAppServerSession: vi.fn((_invocation, run) =>
      run({ request: requestRpcMock, notify: vi.fn() })
    )
  }
})

import { runCodexUserHookTrustRebaseSession } from './codex-user-hook-trust-rebase-client'

const invocation = { command: 'codex', args: ['app-server'], timeoutMs: 1000 }
const oldTrusted = '/home/a/.codex/hooks.json:stop:1:0'
const oldUntrusted = '/home/a/.codex/hooks.json:stop:2:0'
const newTrusted = '/home/a/.codex/hooks.json:stop:0:0'
const newUntrusted = '/home/a/.codex/hooks.json:stop:1:0'

function listing(key: string, command: string, trustStatus: string, enabled = true) {
  return { key, command, currentHash: `sha256:${key}`, trustStatus, enabled }
}

function listResult(hooks: ReturnType<typeof listing>[]) {
  return { data: [{ cwd: '/tmp', hooks }] }
}

beforeEach(() => requestRpcMock.mockReset())

describe('Codex user hook trust rebase RPCs', () => {
  it('captures trusted, untrusted, and disabled states without writing config', async () => {
    requestRpcMock.mockResolvedValueOnce(
      listResult([
        listing(oldTrusted, 'trusted-user', 'trusted'),
        listing(oldUntrusted, 'untrusted-user', 'untrusted', false)
      ])
    )
    const result = await runCodexUserHookTrustRebaseSession({
      operation: 'inspect-user-hook-trust',
      invocation,
      hooksListCwd: '/tmp',
      moves: [
        { oldKey: oldTrusted, newKey: newTrusted, command: 'trusted-user' },
        { oldKey: oldUntrusted, newKey: newUntrusted, command: 'untrusted-user' }
      ]
    })

    expect(result).toEqual({
      outcome: 'inspected',
      moves: [
        expect.objectContaining({ command: 'trusted-user', wasTrusted: true, enabled: true }),
        expect.objectContaining({ command: 'untrusted-user', wasTrusted: false, enabled: false })
      ]
    })
    expect(requestRpcMock).toHaveBeenCalledTimes(1)
  })

  it('clears shifted states, re-grants only prior trust, and verifies by re-list', async () => {
    const postMutation = listResult([
      listing(newTrusted, 'trusted-user', 'untrusted'),
      listing(newUntrusted, 'untrusted-user', 'trusted')
    ])
    const verified = listResult([
      listing(newTrusted, 'trusted-user', 'trusted'),
      listing(newUntrusted, 'untrusted-user', 'untrusted', false)
    ])
    requestRpcMock
      .mockResolvedValueOnce(postMutation)
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce(verified)

    await expect(
      runCodexUserHookTrustRebaseSession({
        operation: 'repair-user-hook-trust',
        invocation,
        hooksListCwd: '/tmp',
        moves: [
          {
            oldKey: oldTrusted,
            newKey: newTrusted,
            command: 'trusted-user',
            reportedOldKey: oldTrusted,
            wasTrusted: true,
            enabled: true
          },
          {
            oldKey: oldUntrusted,
            newKey: newUntrusted,
            command: 'untrusted-user',
            reportedOldKey: oldUntrusted,
            wasTrusted: false,
            enabled: false
          }
        ]
      })
    ).resolves.toEqual({ outcome: 'repaired', repaired: 1 })

    const batch = requestRpcMock.mock.calls[1]
    expect(batch?.[0]).toBe('config/batchWrite')
    expect(batch).toBeDefined()
    const edits = (batch![1] as { edits: { value: unknown }[] }).edits
    expect(edits.some((edit) => edit.value === null)).toBe(true)
    expect(edits).toContainEqual(
      expect.objectContaining({
        value: expect.objectContaining({ trusted_hash: `sha256:${newTrusted}` })
      })
    )
    expect(edits).toContainEqual(expect.objectContaining({ value: { enabled: false } }))
  })
})
