import { expect, it } from 'vitest'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { linksOutsideLinkedChains } from './bot-item-dispatch-facts'

const parents = new Map([
  ['ctx_2', 'ctx_1'],
  ['ctx_3', 'ctx_2']
])
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chain walk reads only follow_up_of_dispatch_id.
const db = {
  getDispatchContextById: (id: string) => ({ follow_up_of_dispatch_id: parents.get(id) ?? null })
} as unknown as OrchestrationDb

it('adds no link for a step of a follow-up chain already linked, before or after it', () => {
  const links = linksOutsideLinkedChains(
    db,
    [{ kind: 'dispatch', ref: 'ctx_2' }],
    [
      { kind: 'dispatch', ref: 'ctx_3' },
      { kind: 'dispatch', ref: 'ctx_1' },
      { kind: 'dispatch', ref: 'ctx_other' },
      { kind: 'dispatch', ref: 'ctx_other' },
      { kind: 'pr', ref: 'acme/app#9' }
    ]
  )

  expect(links).toEqual([
    { kind: 'dispatch', ref: 'ctx_other' },
    { kind: 'pr', ref: 'acme/app#9' }
  ])
})
