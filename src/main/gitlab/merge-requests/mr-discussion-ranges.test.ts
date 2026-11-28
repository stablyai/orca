import { expect, it, vi } from 'vitest'
import { fetchDiscussionComments } from './mr-discussion-notes'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'

vi.mock('../../git/command-runner/hosted-cli/glab-exec-file', () => ({
  glabExecFileAsync: vi.fn()
}))

it('retains new-side discussion ranges without assigning old-side positions to the current file', async () => {
  vi.mocked(glabExecFileAsync).mockResolvedValue({
    stdout: `HTTP/2 200 OK\r\nX-Next-Page: \r\n\r\n${JSON.stringify([
      {
        id: 'review-thread',
        notes: [
          {
            id: 1,
            position: {
              new_path: 'src/app.ts',
              new_line: 7,
              line_range: {
                start: { type: 'new', new_line: 3 },
                end: { type: 'new', new_line: 7 }
              }
            }
          },
          { id: 2, position: { new_path: 'src/app.ts', new_line: 10 } },
          {
            id: 3,
            position: {
              new_path: 'src/app.ts',
              old_line: 9,
              line_range: {
                start: { type: 'old', old_line: 6 },
                end: { type: 'old', old_line: 9 }
              }
            }
          },
          {
            id: 4,
            position: {
              new_path: 'src/app.ts',
              new_line: 12,
              line_range: {
                start: { old_line: 6, new_line: 8 },
                end: { old_line: 10, new_line: 12 }
              }
            }
          }
        ]
      }
    ])}`,
    stderr: ''
  })

  const comments = await fetchDiscussionComments(
    '/repo',
    { host: 'gitlab.example', path: 'team/app' },
    'mr',
    17,
    undefined,
    {},
    false
  )
  expect(comments.map(({ id, path, line, startLine }) => ({ id, path, line, startLine }))).toEqual([
    { id: 1, path: 'src/app.ts', line: 7, startLine: 3 },
    { id: 2, path: 'src/app.ts', line: 10, startLine: undefined },
    { id: 3, path: 'src/app.ts', line: undefined, startLine: undefined },
    { id: 4, path: 'src/app.ts', line: 12, startLine: 8 }
  ])
})
