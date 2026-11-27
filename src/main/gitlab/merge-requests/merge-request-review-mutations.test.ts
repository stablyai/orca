import { expect, it, vi } from 'vitest'
import { addMRInlineComment } from './merge-request-review-mutations'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'

vi.mock('../../git/command-runner/hosted-cli/glab-exec-file', () => ({
  glabExecFileAsync: vi.fn(async () => ({ stdout: '{"id":"d1","notes":[{"id":1}]}', stderr: '' }))
}))

it('sends position[old_line] only for context lines', async () => {
  const projectRef = { host: 'gitlab.example', path: 'team/app' }
  const input = { body: 'note', path: 'a.ts', baseSha: 'b', startSha: 's', headSha: 'h' }
  await addMRInlineComment(
    '/repo',
    7,
    { ...input, line: 2, oldLine: 4 },
    undefined,
    null,
    projectRef
  )
  await addMRInlineComment('/repo', 7, { ...input, line: 3 }, undefined, null, projectRef)

  const [contextArgs, addedArgs] = vi.mocked(glabExecFileAsync).mock.calls.map(([args]) => args)
  expect(contextArgs?.join(' ')).toContain('-f position[new_line]=2 -f position[old_line]=4')
  expect(addedArgs?.join(' ')).toContain('-f position[new_line]=3')
  expect(addedArgs?.join(' ')).not.toContain('position[old_line]')
})
