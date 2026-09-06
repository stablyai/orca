import { describe, expect, it, vi } from 'vitest'
import { MobileWebTaskProjectTablePager } from './mobile-web-task-project-table-pager'

const PAYLOAD = {
  owner: 'stablyai',
  ownerType: 'organization' as const,
  number: 3,
  host: 'github.com',
  viewId: 'view-node'
}

describe('mobile web task project table pager', () => {
  it('serves a stable table through bounded single-use pages', async () => {
    const pager = new MobileWebTaskProjectTablePager((length) => new Uint8Array(length).fill(4))
    const load = vi.fn().mockResolvedValue(projectTable(60))

    const first = await pager.page(PAYLOAD, load)
    expect(first).toMatchObject({
      project: { owner: 'stablyai' },
      selectedView: { id: 'view-node' },
      totalCount: 60
    })
    expect(first.rows).toHaveLength(50)
    expect(first.nextCursor).toMatch(/^task_project_page_0_[a-f0-9]{32}$/)

    const second = await pager.page({ ...PAYLOAD, cursor: first.nextCursor! }, load)
    expect(second.project).toBeUndefined()
    expect(second.rows).toHaveLength(10)
    expect(second.nextCursor).toBeNull()
    expect(load).toHaveBeenCalledOnce()
    await expect(pager.page({ ...PAYLOAD, cursor: first.nextCursor! }, load)).rejects.toMatchObject(
      { code: 'invalid_request' }
    )
  })

  it('revokes continuations and rejects a row too large for one page', async () => {
    const pager = new MobileWebTaskProjectTablePager((length) => new Uint8Array(length))
    const first = await pager.page(PAYLOAD, async () => projectTable(2))
    pager.clear()
    if (first.nextCursor) {
      await expect(
        pager.page({ ...PAYLOAD, cursor: first.nextCursor }, async () => projectTable(2))
      ).rejects.toMatchObject({ code: 'invalid_request' })
    }

    await expect(
      pager.page(PAYLOAD, async () => {
        const table = projectTable(1)
        table.rows[0]!.content.body = 'x'.repeat(60 * 1024)
        table.rows[0]!.fieldValuesByFieldId = Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => [
            `field-${index}`,
            {
              kind: 'text',
              fieldId: `field-${index}`,
              text: 'y'.repeat(4_096)
            }
          ])
        )
        return table
      })
    ).rejects.toMatchObject({ code: 'too_large' })
  })
})

function projectTable(count: number) {
  return {
    project: {
      id: 'project-node',
      host: 'github.com',
      owner: 'stablyai',
      ownerType: 'organization',
      number: 3,
      title: 'Mobile',
      url: 'https://github.com/orgs/stablyai/projects/3'
    },
    selectedView: {
      id: 'view-node',
      number: 1,
      name: 'Roadmap',
      filter: '',
      layout: 'TABLE_LAYOUT',
      fields: [],
      groupByFields: [],
      sortByFields: []
    },
    rows: Array.from({ length: count }, (_, position) => ({
      id: `item-${position}`,
      itemType: 'ISSUE',
      content: {
        number: position + 1,
        title: `Item ${position}`,
        body: null as string | null,
        url: `https://github.com/stablyai/orca/issues/${position + 1}`,
        state: 'OPEN',
        stateReason: null,
        isDraft: false,
        repository: 'stablyai/orca',
        issueType: null,
        labels: [],
        assignees: [],
        parentIssue: null
      },
      fieldValuesByFieldId: {},
      updatedAt: '2026-07-24T00:00:00Z',
      position
    })),
    totalCount: count,
    parentFieldDropped: false
  }
}
