import { describe, expect, it } from 'vitest'
import { LINEAR_PRIORITY_NUMBERS } from '../../../cloud/packages/connector-contract/src/linear-issue-names'
import { LINEAR_PRIORITY_LABELS } from '../../shared/linear/priority-label'

// The shipped CLI can't import cloud sources, so its priority names are pinned to the connector's here.
describe('LINEAR_PRIORITY_LABELS', () => {
  it('names the same numbers as the cloud connector', () => {
    expect(
      Object.fromEntries(
        Object.entries(LINEAR_PRIORITY_LABELS).map(([priority, label]) => [label, Number(priority)])
      )
    ).toEqual(LINEAR_PRIORITY_NUMBERS)
  })
})
