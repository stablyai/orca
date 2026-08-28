import { describe, expect, it } from 'vitest'
import { FolderWorkspacePathStatusArgs } from './repo-ipc-arg-schemas'

describe('folder workspace path status IPC schema', () => {
  it('normalizes repo execution host ids', () => {
    expect(
      FolderWorkspacePathStatusArgs.parse({
        scope: 'repo',
        repoId: 'repo-1',
        executionHostId: ' local '
      })
    ).toEqual({ scope: 'repo', repoId: 'repo-1', executionHostId: 'local' })
  })
})
