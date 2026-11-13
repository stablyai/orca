import { afterEach, expect, it } from 'vitest'
import { createGitOperationExecutor } from '../git/command-runner/admission/git-operation-executor'
import { runWithGitCause } from './git-operation-cause'
import { startGitSpan, withGitSpan, _resetGitSpanSamplingForTests } from './git-execution-spans'
import { setActiveSink } from './tracer'

afterEach(() => {
  setActiveSink(null)
  _resetGitSpanSamplingForTests()
})

it('attributes scoped Git intent without retaining argv operands in its shape', async () => {
  const records: unknown[] = []
  setActiveSink({ push: (record) => records.push(record), flush() {}, close() {} })
  await createGitOperationExecutor('background').run(() =>
    runWithGitCause(
      { family: 'catalog', reason: 'desktop-catalog', cache: 'miss' },
      undefined,
      () =>
        withGitSpan(
          {
            args: [
              '-C',
              '/private/repo',
              '-c',
              'key=private-value',
              'worktree',
              'list',
              '--porcelain',
              '-z'
            ]
          },
          async () => undefined
        )
    )
  )
  await withGitSpan(
    { args: ['commit', '-mprivate-message', '--', '--private-file'], admissionTier: 'interactive' },
    async () => undefined
  )
  await runWithGitCause(
    { family: 'refs', reason: 'branch-snapshot', cache: 'uncached' },
    undefined,
    async () => startGitSpan({ args: ['diff', '--output=/private/output', '--', 'file'] }).end()
  )
  expect(records).toEqual([
    expect.objectContaining({
      attributes: expect.objectContaining({
        'git.caller': 'desktop-catalog',
        'git.argv_shape': 'worktree list --porcelain',
        'git.admission_tier': 'background',
        'git.foreground': false
      })
    }),
    expect.objectContaining({
      attributes: expect.objectContaining({
        'git.caller': 'unattributed',
        'git.argv_shape': 'commit -m',
        'git.admission_tier': 'interactive',
        'git.foreground': true
      })
    }),
    expect.objectContaining({
      attributes: expect.objectContaining({
        'git.caller': 'branch-snapshot',
        'git.argv_shape': 'diff --output',
        'git.admission_tier': 'status',
        'git.foreground': 'unknown'
      })
    })
  ])
  expect(JSON.stringify(records)).not.toMatch(/private|key=/)
})
