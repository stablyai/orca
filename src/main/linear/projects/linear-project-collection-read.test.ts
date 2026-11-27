import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ entries: new Array<ReturnType<typeof entry>>() }))
vi.mock('../accounts/linear-account-client', () => ({
  getClients: async () => state.entries,
  isAuthError: () => false
}))

import { listProjects } from './linear-project-queries'

const entry = (id: string, wait?: () => Promise<void>) => ({
  workspace: { id, organizationName: id },
  client: {
    client: {
      rawRequest: async () => {
        await wait?.()
        return {
          data: {
            projects: {
              nodes: [{ id: `project-${id}`, name: id }],
              pageInfo: { hasNextPage: false }
            }
          }
        }
      }
    }
  }
})

it('keeps a pending default-workspace read separate after the selected workspace changes', async () => {
  const started = Promise.withResolvers<void>()
  const finishFirst = Promise.withResolvers<void>()
  state.entries = [
    entry('alpha', async () => {
      started.resolve()
      await finishFirst.promise
    })
  ]
  const first = listProjects(undefined, 20)
  await started.promise
  state.entries = [entry('beta')]
  const second = listProjects(undefined, 20)
  finishFirst.resolve()
  const [oldSelection, newSelection] = await Promise.all([first, second])
  expect(oldSelection.items.map((project) => project.workspaceId)).toEqual(['alpha'])
  expect(newSelection.items.map((project) => project.workspaceId)).toEqual(['beta'])
})
