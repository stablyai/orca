import { describe, expect, it } from 'vitest'
import { resolveNestedRepoImportPaths } from './nested-repo-import'

describe('createNestedProjectGroupResolver', () => {
  it('rejects stopped-scan import paths that escape the selected parent with dot segments', () => {
    const selection = resolveNestedRepoImportPaths({
      parentPath: '/workspace/platform',
      projectPaths: [
        '/workspace/platform/api',
        '/workspace/platform/../outside-repo',
        '/workspace/platform/apps/../../other-outside-repo'
      ]
    })

    expect(selection.selectedPaths).toEqual(['/workspace/platform/api'])
    expect(selection.rejectedPaths).toEqual([
      '/workspace/platform/../outside-repo',
      '/workspace/platform/apps/../../other-outside-repo'
    ])
  })
})
