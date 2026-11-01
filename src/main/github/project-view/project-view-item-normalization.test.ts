import { describe, expect, it } from 'vitest'
import { normalizeItem } from './project-view-item-normalization'

describe('normalizeItem item type', () => {
  it('keeps DraftIssue content as a draft without a repository', () => {
    const result = normalizeItem(
      {
        id: 'draft',
        type: 'DRAFT_ISSUE',
        content: { __typename: 'DraftIssue', title: 'Draft', body: 'Draft body' },
        fieldValues: {
          nodes: [
            {
              __typename: 'ProjectV2ItemFieldSingleSelectValue',
              field: { id: 'status', name: 'Status', dataType: 'SINGLE_SELECT' },
              optionId: 'todo',
              name: 'Todo',
              color: 'GRAY'
            }
          ],
          pageInfo: { hasNextPage: false }
        }
      },
      0
    )

    expect(result).toMatchObject({
      ok: true,
      row: {
        itemType: 'DRAFT_ISSUE',
        content: { title: 'Draft', body: 'Draft body', repository: null, number: null, url: null },
        fieldValuesByFieldId: { status: { kind: 'single-select', name: 'Todo' } }
      }
    })
  })

  it('treats absent content as restricted whatever the original type', () => {
    for (const type of ['ISSUE', 'PULL_REQUEST', 'DRAFT_ISSUE']) {
      expect(normalizeItem({ id: `restricted-${type}`, type, content: null }, 0)).toMatchObject({
        ok: true,
        row: {
          itemType: 'REDACTED',
          content: { title: 'Restricted item', repository: null, number: null }
        }
      })
    }
  })
})
