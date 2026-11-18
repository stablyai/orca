import { describe, expect, it } from 'vitest'
import { budgetItemsByKindPage } from './journal-items-by-kind-page'

describe('budgetItemsByKindPage', () => {
  const row = (itemId: string, ordinal: number, padding: number) => ({
    payload_json: JSON.stringify({ itemId, text: 'x'.repeat(padding) }),
    ordinal
  })

  it('ends the page before the row that would pass the JSON budget and resumes after the last kept', () => {
    const page = budgetItemsByKindPage(
      [row('a', 4, 40), row('b', 9, 40), row('c', 12, 40)],
      30,
      130
    )
    expect(page.items.map((item) => item.itemId)).toEqual(['a', 'b'])
    expect(page.nextOrdinal).toBe(9)
  })

  it('sends a lone row larger than the budget and keeps the caller cursor when every row fits', () => {
    expect(budgetItemsByKindPage([row('big', 5, 500), row('next', 6, 1)], null, 100)).toMatchObject(
      {
        items: [{ itemId: 'big' }],
        nextOrdinal: 5
      }
    )
    expect(budgetItemsByKindPage([row('a', 1, 1), row('b', 2, 1)], null, 100)).toMatchObject({
      items: [{ itemId: 'a' }, { itemId: 'b' }],
      nextOrdinal: null
    })
  })
})
