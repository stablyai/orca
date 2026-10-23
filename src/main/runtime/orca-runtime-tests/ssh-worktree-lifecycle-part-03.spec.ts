import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('uses remote path joins for SSH issue-command files and touches no filesystem', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: 'C:/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const runtime = new OrcaRuntimeService(remoteStore as never)

    await expect(runtime.checkRepoHooks('id:repo-1')).resolves.toMatchObject({
      status: 'error',
      hasHooks: false
    })
    await expect(runtime.readRepoIssueCommand('id:repo-1')).resolves.toMatchObject({
      localContent: null,
      effectiveContent: null,
      localFilePath: 'C:\\remote\\repo\\.orca\\issue-command'
    })
    await expect(runtime.writeRepoIssueCommand('id:repo-1', 'Ship it')).resolves.toEqual({
      ok: true
    })
  })
})
