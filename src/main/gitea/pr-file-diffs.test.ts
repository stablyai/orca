import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestGiteaJsonMock, requestGiteaTextMock } = vi.hoisted(() => ({
  requestGiteaJsonMock: vi.fn(),
  requestGiteaTextMock: vi.fn()
}))

vi.mock('./client', () => ({
  requestGiteaJson: requestGiteaJsonMock,
  requestGiteaText: requestGiteaTextMock
}))

import { fetchGiteaPRFiles } from './pr-file-diffs'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

const unifiedDiff = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 111..222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/src/old-name.ts b/src/new-name.ts',
  'similarity index 90%',
  'rename from src/old-name.ts',
  'rename to src/new-name.ts',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  'diff --git a/removed.ts b/removed.ts',
  'deleted file mode 100644',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git a/added.ts b/added.ts',
  'new file mode 100644',
  '@@ -0,0 +1 @@',
  '+hello',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'index 0000000..abc',
  'Binary files /dev/null and b/logo.png differ',
  ''
].join('\n')

describe('fetchGiteaPRFiles', () => {
  beforeEach(() => {
    requestGiteaJsonMock.mockReset()
    requestGiteaTextMock.mockReset()
  })

  it('maps added, modified, renamed, deleted, and binary files onto per-file diffs', async () => {
    requestGiteaJsonMock.mockResolvedValue([
      {
        filename: 'src/app.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-old\n+new\n'
      },
      {
        filename: 'src/new-name.ts',
        previous_filename: 'src/old-name.ts',
        status: 'renamed',
        additions: 1,
        deletions: 1
      },
      {
        filename: 'removed.ts',
        status: 'deleted',
        additions: 0,
        deletions: 1
      },
      {
        filename: 'added.ts',
        status: 'added',
        additions: 1,
        deletions: 0
      },
      {
        filename: 'logo.png',
        status: 'added',
        additions: 0,
        deletions: 0
      }
    ])
    requestGiteaTextMock.mockResolvedValue(unifiedDiff)

    const files = await fetchGiteaPRFiles(repo, 8)

    expect(requestGiteaJsonMock).toHaveBeenCalledWith(repo, '/repos/team/widgets/pulls/8/files', {
      searchParams: { limit: 100 }
    })
    expect(requestGiteaTextMock).toHaveBeenCalledWith(repo, '/repos/team/widgets/pulls/8.diff')
    expect(files).toEqual([
      {
        path: 'src/app.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        isBinary: false,
        diff: '@@ -1 +1 @@\n-old\n+new\n'
      },
      {
        path: 'src/new-name.ts',
        oldPath: 'src/old-name.ts',
        status: 'renamed',
        additions: 1,
        deletions: 1,
        isBinary: false,
        diff: [
          'diff --git a/src/old-name.ts b/src/new-name.ts',
          'similarity index 90%',
          'rename from src/old-name.ts',
          'rename to src/new-name.ts',
          '@@ -1 +1 @@',
          '-a',
          '+b',
          ''
        ].join('\n')
      },
      {
        path: 'removed.ts',
        status: 'deleted',
        additions: 0,
        deletions: 1,
        isBinary: false,
        diff: [
          'diff --git a/removed.ts b/removed.ts',
          'deleted file mode 100644',
          '@@ -1 +0,0 @@',
          '-gone',
          ''
        ].join('\n')
      },
      {
        path: 'added.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
        isBinary: false,
        diff: [
          'diff --git a/added.ts b/added.ts',
          'new file mode 100644',
          '@@ -0,0 +1 @@',
          '+hello',
          ''
        ].join('\n')
      },
      {
        path: 'logo.png',
        status: 'added',
        additions: 0,
        deletions: 0,
        isBinary: true,
        diff: [
          'diff --git a/logo.png b/logo.png',
          'new file mode 100644',
          'index 0000000..abc',
          'Binary files /dev/null and b/logo.png differ',
          ''
        ].join('\n')
      }
    ])
  })
})
