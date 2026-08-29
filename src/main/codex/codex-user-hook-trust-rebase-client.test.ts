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

const invocation = { command: 'codex', cliPath: null, args: ['app-server'], timeoutMs: 1000 }
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
        expect.objectContaining({
          command: 'trusted-user',
          currentHash: `sha256:${oldTrusted}`,
          wasTrusted: true,
          enabled: true
        }),
        expect.objectContaining({
          command: 'untrusted-user',
          currentHash: `sha256:${oldUntrusted}`,
          wasTrusted: false,
          enabled: false
        })
      ]
    })
    expect(requestRpcMock).toHaveBeenCalledTimes(1)
  })

  it('rejects conflicting Windows variants during system trust inspection', async () => {
    const backslashKey = 'C:\\system\\hooks.json:stop:0:0'
    const slashKey = 'C:/system/hooks.json:stop:0:0'
    requestRpcMock.mockResolvedValueOnce(
      listResult([
        listing(backslashKey, 'user-stop-hook', 'trusted'),
        listing(slashKey, 'user-stop-hook', 'modified')
      ])
    )

    await expect(
      runCodexUserHookTrustRebaseSession({
        operation: 'inspect-user-hook-trust',
        invocation,
        hooksListCwd: 'C:\\system',
        moves: [{ oldKey: backslashKey, newKey: newTrusted, command: 'user-stop-hook' }]
      })
    ).rejects.toThrow('ambiguous hook key variants')
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

  it('clears both Windows separator variants when repairing moved trust', async () => {
    const oldBackslashKey = 'C:\\runtime\\hooks.json:stop:1:0'
    const oldSlashKey = 'C:/runtime/hooks.json:stop:1:0'
    const newBackslashKey = 'C:\\runtime\\hooks.json:stop:0:0'
    const newSlashKey = 'C:/runtime/hooks.json:stop:0:0'
    const postMutation = listing(newBackslashKey, 'user-stop-hook', 'untrusted')
    const verified = listing(newBackslashKey, 'user-stop-hook', 'trusted')
    requestRpcMock
      .mockResolvedValueOnce(listResult([postMutation, { ...postMutation, key: newSlashKey }]))
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce(listResult([verified, { ...verified, key: newSlashKey }]))

    await runCodexUserHookTrustRebaseSession({
      operation: 'repair-user-hook-trust',
      invocation,
      hooksListCwd: 'C:\\runtime',
      moves: [
        {
          oldKey: oldBackslashKey,
          newKey: newBackslashKey,
          command: 'user-stop-hook',
          reportedOldKey: oldBackslashKey,
          wasTrusted: true,
          enabled: true
        }
      ]
    })

    const edits = (
      requestRpcMock.mock.calls[1]![1] as {
        edits: { keyPath: string; value: unknown }[]
      }
    ).edits
    const clearedKeyPaths = edits.filter((edit) => edit.value === null).map((edit) => edit.keyPath)
    expect(clearedKeyPaths).toEqual([
      'hooks.state."C:\\\\runtime\\\\hooks.json:stop:1:0"',
      `hooks.state."${oldSlashKey}"`,
      'hooks.state."C:\\\\runtime\\\\hooks.json:stop:0:0"',
      `hooks.state."${newSlashKey}"`
    ])
  })

  it('writes runtime currentHash for approved mirrored hooks and verifies by re-list', async () => {
    const preToolKey = '/runtime/hooks.json:pre_tool_use:1:0'
    const postToolKey = '/runtime/hooks.json:post_tool_use:1:0'
    requestRpcMock
      .mockResolvedValueOnce(
        listResult([
          listing(preToolKey, 'user-pre-tool-hook', 'modified'),
          listing(postToolKey, 'user-post-tool-hook', 'modified', false)
        ])
      )
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce(
        listResult([
          listing(preToolKey, 'user-pre-tool-hook', 'trusted'),
          listing(postToolKey, 'user-post-tool-hook', 'trusted', false)
        ])
      )

    await expect(
      runCodexUserHookTrustRebaseSession({
        operation: 'grant-mirrored-runtime-hook-trust',
        invocation,
        hooksListCwd: '/tmp',
        targets: [
          { key: preToolKey, command: 'user-pre-tool-hook', enabled: true },
          { key: postToolKey, command: 'user-post-tool-hook', enabled: false }
        ]
      })
    ).resolves.toEqual({
      outcome: 'mirrored-granted',
      entries: [
        {
          key: preToolKey,
          command: 'user-pre-tool-hook',
          currentHash: `sha256:${preToolKey}`
        },
        {
          key: postToolKey,
          command: 'user-post-tool-hook',
          currentHash: `sha256:${postToolKey}`
        }
      ]
    })
    expect(requestRpcMock).toHaveBeenCalledTimes(3)
    const batch = requestRpcMock.mock.calls[1]
    expect(batch?.[0]).toBe('config/batchWrite')
    expect(batch).toBeDefined()
    const edits = (batch![1] as { edits: { value: unknown }[] }).edits
    expect(edits).toContainEqual(
      expect.objectContaining({
        value: { trusted_hash: `sha256:${preToolKey}` }
      })
    )
    expect(edits).toContainEqual(
      expect.objectContaining({
        value: { trusted_hash: `sha256:${postToolKey}`, enabled: false }
      })
    )
  })

  it('accepts equivalent Windows separator variants reported by hooks/list', async () => {
    const backslashKey = 'C:\\runtime\\hooks.json:pre_tool_use:1:0'
    const slashKey = 'C:/runtime/hooks.json:pre_tool_use:1:0'
    const before = listing(backslashKey, 'user-pre-tool-hook', 'modified')
    const after = listing(backslashKey, 'user-pre-tool-hook', 'trusted')
    requestRpcMock
      .mockResolvedValueOnce(listResult([before, { ...before, key: slashKey }]))
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce(listResult([after, { ...after, key: slashKey }]))

    await expect(
      runCodexUserHookTrustRebaseSession({
        operation: 'grant-mirrored-runtime-hook-trust',
        invocation,
        hooksListCwd: 'C:\\runtime',
        targets: [{ key: backslashKey, command: 'user-pre-tool-hook', enabled: true }]
      })
    ).resolves.toEqual({
      outcome: 'mirrored-granted',
      entries: [
        {
          key: backslashKey,
          command: 'user-pre-tool-hook',
          currentHash: before.currentHash
        }
      ]
    })
  })
})
