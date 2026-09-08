import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { MOBILE_WEB_TASK_PROJECT_TABLE_METHOD } from './mobile-web-task-project-table'

const request = {
  owner: 'octo',
  ownerType: 'organization',
  projectNumber: 4,
  viewId: 'PVTV_1'
}

function fixture(raw: unknown) {
  const handler = vi.fn().mockResolvedValue(raw)
  const context = { runtime: { getGitHubProjectViewTable: handler } } as unknown as RpcContext
  return {
    handler,
    run: (params: Record<string, unknown> = {}) =>
      MOBILE_WEB_TASK_PROJECT_TABLE_METHOD.handler(
        MOBILE_WEB_TASK_PROJECT_TABLE_METHOD.params!.parse({ ...request, ...params }),
        context
      ) as Promise<Record<string, unknown>>
  }
}

function table(rowCount: number, titleLength = 8) {
  return {
    ok: true,
    data: {
      project: { owner: 'octo', ownerType: 'organization', number: 4, host: 'github.com' },
      selectedView: { id: 'PVTV_1', name: 'Board' },
      totalCount: rowCount,
      rows: Array.from({ length: rowCount }, (_, index) => ({
        id: `row-${index}`,
        content: { title: 'x'.repeat(titleLength), repository: 'octo/app', number: index }
      }))
    }
  }
}

afterEach(() => vi.restoreAllMocks())

describe('mobileWeb.tasks.projectTable', () => {
  it('returns the whole table in one window when it fits the bridge envelope', async () => {
    const f = fixture(table(3))
    const result = await f.run()
    expect((result.data as { rows: unknown[] }).rows).toHaveLength(3)
    expect(result.nextRowOffset).toBeUndefined()
  })

  it('clips an oversized table and reports where the next window starts', async () => {
    const raw = table(500, 4_000)
    expect(Buffer.byteLength(JSON.stringify(raw.data))).toBeGreaterThan(512 * 1024)
    const f = fixture(raw)
    const first = await f.run()
    const rows = (first.data as { rows: { id: string }[] }).rows
    expect(rows.length).toBeLessThan(500)
    expect(rows[0]!.id).toBe('row-0')
    expect(Buffer.byteLength(JSON.stringify(first.data))).toBeLessThanOrEqual(512 * 1024)
    expect(first.nextRowOffset).toBe(rows.length)

    const second = await f.run({ rowOffset: first.nextRowOffset })
    expect((second.data as { rows: { id: string }[] }).rows[0]!.id).toBe(`row-${rows.length}`)
  })

  it('keeps the table metadata on every window so the caller can rebuild the table', async () => {
    const f = fixture(table(500, 4_000))
    const second = await f.run({ rowOffset: 400 })
    expect(second.data).toMatchObject({ totalCount: 500, selectedView: { id: 'PVTV_1' } })
  })

  it('returns a classified failure when one row cannot cross the bridge', async () => {
    const f = fixture(table(3, 600 * 1024))
    const result = await f.run()
    expect(result).toMatchObject({ ok: false, error: { type: 'too_large' } })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512 * 1024)
  })

  it('passes a host failure envelope through untouched', async () => {
    const failure = { ok: false, error: { message: 'View has 900 items.', type: 'too_large' } }
    const f = fixture(failure)
    expect(await f.run()).toEqual(failure)
  })

  it('never forwards the page row offset to the GitHub query', async () => {
    const f = fixture(table(3))
    await f.run({ rowOffset: 2 })
    expect(f.handler).toHaveBeenCalledWith(
      expect.not.objectContaining({ rowOffset: expect.anything() })
    )
  })
})
