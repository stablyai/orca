import { describe, expect, it } from 'vitest'

import { branchCommitsSinceBase } from './mobile-pr-create-draft'

describe('branchCommitsSinceBase', () => {
  const item = (id: string, parentIds: string[], subject = id) => ({ id, parentIds, subject })

  it("gives up on merged history rather than list the base's commits as the branch's own", () => {
    // git log --topo-order after `git merge main` on a two-commit branch; rev-list main..HEAD counts 3.
    const history = {
      items: [
        item('merge', ['two', 'mainB']),
        item('mainB', ['mainA']),
        item('mainA', ['base']),
        item('two', ['one']),
        item('one', ['base']),
        item('base', [])
      ]
    }
    expect(branchCommitsSinceBase(history, 3)).toEqual([])
    const linear = { items: [item('two', ['one']), item('one', ['base']), item('base', [])] }
    expect(branchCommitsSinceBase(linear, 2).map((commit) => commit.id)).toEqual(['two', 'one'])
  })
})
