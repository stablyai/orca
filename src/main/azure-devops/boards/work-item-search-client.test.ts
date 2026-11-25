import { expect, it } from 'vitest'
import { workItemIdsFromWiqlResult } from './work-item-search-client'

it('reads ids from flat and link WIQL results once each, in result order', () => {
  expect(
    workItemIdsFromWiqlResult({
      workItems: [{ id: 7 }, { id: 3 }, {}],
      workItemRelations: [
        { source: null, target: { id: 3 } },
        { source: { id: 3 }, target: { id: 9 } },
        { source: { id: 9 }, target: null }
      ]
    })
  ).toEqual([7, 3, 9])
  expect(workItemIdsFromWiqlResult(null)).toEqual([])
})
