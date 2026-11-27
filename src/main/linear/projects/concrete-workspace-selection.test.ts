import { expect, it, vi } from 'vitest'

vi.mock('../accounts/linear-account-client', () => ({
  getClients: async () => [
    {
      workspace: { id: 'alpha', organizationName: 'Alpha' },
      client: {
        client: {
          rawRequest: async () => ({
            data: { project: { id: 'project', name: 'Alpha project' } }
          })
        }
      }
    }
  ],
  isAuthError: () => false
}))

import { getProject } from './linear-project-queries'

it('rejects a padded all-workspace selector before choosing the first connected project', async () => {
  await expect(getProject('project', ' \tall\r\n')).rejects.toThrow(
    'Concrete Linear workspace ID is required'
  )
  expect(await getProject('project', ' alpha ')).toMatchObject({
    id: 'project',
    workspaceId: 'alpha'
  })
})
