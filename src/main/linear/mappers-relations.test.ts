import { describe, expect, it, vi } from 'vitest'
import { mapLinearIssue } from './mappers'

const labelNodes = [{ id: 'label-1', name: 'Bug' }]
const childNodes = [
  { id: 'child-1', identifier: 'LIN-2', title: 'Child', url: 'https://linear.app/issue/LIN-2' }
]

function createIssue() {
  return {
    id: 'issue-1',
    identifier: 'LIN-1',
    title: 'Parent',
    url: 'https://linear.app/issue/LIN-1',
    priority: 1,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    state: Promise.resolve({ name: 'Open', type: 'unstarted', color: '' }),
    team: Promise.resolve({ id: 'team-1', name: 'Team', key: 'LIN' }),
    assignee: Promise.resolve(undefined),
    project: Promise.resolve(undefined),
    labels: vi.fn(async () => ({ nodes: labelNodes })),
    children: vi.fn(async () => ({ nodes: childNodes }))
  }
}

type IssueFixture = Omit<
  ReturnType<typeof createIssue>,
  'state' | 'team' | 'labels' | 'children'
> & {
  state: ReturnType<typeof createIssue>['state'] | Promise<undefined>
  team: ReturnType<typeof createIssue>['team'] | Promise<undefined>
  labels: () => Promise<{ nodes: typeof labelNodes } | null>
  children: (options?: { first: number }) => Promise<{ nodes: typeof childNodes } | null>
}

function mapFixture(issue: IssueFixture, options: Parameters<typeof mapLinearIssue>[1] = {}) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixtures supply every mapper-read member; malformed optional connections deliberately exercise its catches.
  return mapLinearIssue(issue as never, options)
}

describe('mapLinearIssue optional connections', () => {
  it.each(['labels', 'children'] as const)(
    'starts both connections after all core relations settle while %s remains pending',
    async (pendingRelation) => {
      const coreReads = Array.from({ length: 4 }, () => Promise.withResolvers<undefined>())
      const labels = Promise.withResolvers<{ nodes: typeof labelNodes }>()
      const children = Promise.withResolvers<{ nodes: typeof childNodes }>()
      const issue = {
        ...createIssue(),
        state: coreReads[0].promise,
        team: coreReads[1].promise,
        assignee: coreReads[2].promise,
        project: coreReads[3].promise,
        labels: vi.fn(() => labels.promise),
        children: vi.fn(() => children.promise)
      }
      let completed = false
      const mapped = mapFixture(issue, { includeProject: true, includeChildren: true }).then(
        (result) => {
          completed = true
          return result
        }
      )

      for (const core of coreReads) {
        expect(issue.labels).not.toHaveBeenCalled()
        expect(issue.children).not.toHaveBeenCalled()
        core.resolve(undefined)
        await Promise.resolve()
      }
      // Drain the core Promise.all without completing either connection.
      await Promise.resolve()
      await Promise.resolve()
      expect(issue.labels).toHaveBeenCalledExactlyOnceWith()
      expect(issue.children).toHaveBeenCalledExactlyOnceWith({ first: 25 })
      expect(completed).toBe(false)

      if (pendingRelation === 'labels') {
        children.resolve({ nodes: childNodes })
      } else {
        labels.resolve({ nodes: labelNodes })
      }
      await Promise.resolve()
      await Promise.resolve()
      expect(completed).toBe(false)

      labels.resolve({ nodes: labelNodes })
      children.resolve({ nodes: childNodes })
      await expect(mapped).resolves.toMatchObject({
        labels: ['Bug'],
        labelIds: ['label-1'],
        subIssues: childNodes
      })
    }
  )

  it.each(['reject', 'throw', 'malformed'] as const)(
    'preserves children when the label connection fails: %s',
    async (failure) => {
      const labels = vi.fn(() => {
        if (failure === 'throw') {
          throw new Error('labels failed')
        }
        return failure === 'reject'
          ? Promise.reject(new Error('labels failed'))
          : Promise.resolve(null)
      })
      const result = await mapFixture({ ...createIssue(), labels }, { includeChildren: true })
      expect(result.labels).toEqual([])
      expect(result.labelIds).toEqual([])
      expect(result.subIssues).toEqual(childNodes)
    }
  )

  it.each(['reject', 'throw', 'malformed'] as const)(
    'preserves labels when the child connection fails: %s',
    async (failure) => {
      const children = vi.fn(() => {
        if (failure === 'throw') {
          throw new Error('children failed')
        }
        return failure === 'reject'
          ? Promise.reject(new Error('children failed'))
          : Promise.resolve(null)
      })
      const result = await mapFixture({ ...createIssue(), children }, { includeChildren: true })
      expect(result.labels).toEqual(['Bug'])
      expect(result.labelIds).toEqual(['label-1'])
      expect(result).toHaveProperty('subIssues', undefined)
    }
  )

  it.each([{}, { includeChildren: false, includeProject: false }])(
    'respects project and child opt-outs: %j',
    async (options) => {
      const project = vi.fn(() => {
        throw new Error('project must not be accessed')
      })
      const issue = {
        ...createIssue(),
        get project() {
          return project()
        }
      }
      const result = await mapFixture(issue, options)
      expect(project).not.toHaveBeenCalled()
      expect(issue.children).not.toHaveBeenCalled()
      expect(issue.labels).toHaveBeenCalledExactlyOnceWith()
      expect(result).toHaveProperty('project', undefined)
      expect(result).toHaveProperty('subIssues', undefined)
    }
  )
})
