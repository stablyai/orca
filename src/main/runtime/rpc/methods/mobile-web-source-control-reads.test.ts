import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { MOBILE_WEB_SOURCE_CONTROL_READ_METHODS } from './mobile-web-source-control-reads'

const signal = new AbortController().signal
const worktree = 'id:private-host-workspace'
function fixture(operation: 'status' | 'diff', raw: unknown) {
  const handler = vi.fn().mockResolvedValue(raw)
  const context = {
    signal,
    clientKind: 'mobile',
    requestId: 'mobile-diff',
    runtime: { [operation === 'status' ? 'getRuntimeGitStatus' : 'getRuntimeGitDiff']: handler }
  } as unknown as RpcContext
  const method = MOBILE_WEB_SOURCE_CONTROL_READ_METHODS.find(
    (entry) => entry.name === `mobileWeb.sourceControl.${operation}`
  )!
  return {
    handler,
    run: (params: Record<string, unknown>) =>
      method.handler(method.params!.parse({ worktree, ...params }), context)
  }
}
afterEach(() => vi.restoreAllMocks())

describe('bounded host Source Control reads', () => {
  it('projects an oversized status before it crosses the bridge without changing the native result', async () => {
    const raw = {
      worktree,
      rootPath: '/private/repo',
      conflictOperation: 'unknown',
      entries: Array.from({ length: 10_000 }, (_, i) => ({
        path: `src/${i}.ts`,
        status: 'modified',
        area: 'unstaged'
      }))
    }
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(512 * 1024)
    const f = fixture('status', raw)
    const result = await f.run({ limit: 2 })
    expect(result).toMatchObject({
      entries: [{ relativePath: 'src/0.ts' }, { relativePath: 'src/1.ts' }],
      totalCount: 10_000,
      truncated: true
    })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512 * 1024)
    expect(JSON.stringify(result)).not.toMatch(/private|workspaceId/)
    expect(raw.entries).toHaveLength(10_000)
    expect(f.handler).toHaveBeenCalledWith(worktree, {
      reuseLineStats: true,
      admissionTier: 'status',
      signal
    })
  })
  it('pages a diff whose raw contents exceed the bridge budget and checks the revision on later pages', async () => {
    const raw = {
      kind: 'text',
      originalContent: `${'a'.repeat(300_000)}\nold`,
      modifiedContent: `${'a'.repeat(300_000)}\nnew`
    }
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(512 * 1024)
    const f = fixture('diff', raw)
    const params = { relativePath: 'large.txt', area: 'unstaged', offset: 0, limit: 1 }
    const first = (await f.run(params)) as { revision: string }
    expect(first).toMatchObject({ kind: 'text', rows: [{ textTruncated: true }], nextOffset: 1 })
    const next = await f.run({ ...params, offset: 1, expectedRevision: first.revision })
    expect(next).toMatchObject({ kind: 'text', offset: 1, rows: [{ kind: 'delete', text: 'old' }] })
    await expect(f.run({ ...params, expectedRevision: '0'.repeat(64) })).rejects.toThrow('conflict')
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(512 * 1024)
    expect(JSON.stringify(first)).not.toMatch(/private|workspaceId/)
    expect(raw.originalContent.length).toBeGreaterThan(300_000)
    expect(f.handler).toHaveBeenCalledWith(worktree, 'large.txt', false)
  })
  it('keeps escaped diff rows below the wire budget without skipping the next page', async () => {
    const f = fixture('diff', {
      kind: 'text',
      originalContent: '',
      modifiedContent: Array(96).fill('\u0000'.repeat(1024)).join('\n')
    })
    const result = (await f.run({
      relativePath: 'escaped.txt',
      area: 'unstaged',
      offset: 0,
      limit: 96
    })) as { rows: unknown[]; nextOffset: number }
    expect(result.rows.length).toBeLessThan(96)
    expect(result.nextOffset).toBe(result.rows.length)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024)
  })
  it('preserves host errors instead of substituting a local result', async () => {
    const f = fixture('status', {})
    f.handler.mockRejectedValue(new Error('SSH provider unavailable'))
    await expect(f.run({ limit: 2 })).rejects.toThrow('SSH provider unavailable')
  })
})
