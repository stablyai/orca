import { describe, expect, it, vi } from 'vitest'
import { hasNoChangedFiles } from './vitest-changed-precheck.mjs'

const clean = () => vi.fn(async () => ({ code: 0, stdout: '' }))

describe('hasNoChangedFiles', () => {
  it('also checks commits since the ref', async () => {
    const runProcess = clean()
    await expect(
      hasNoChangedFiles(['run', '--changed=origin/main'], '/repo', runProcess)
    ).resolves.toBe(true)
    expect(runProcess.mock.calls.map(([spec]) => spec.args)).toContainEqual([
      'diff',
      '--name-only',
      '-z',
      'origin/main...HEAD'
    ])
  })

  it('starts Vitest when Git reports a file or cannot answer', async () => {
    for (const result of [
      { code: 0, stdout: '?? src/a.ts\0' },
      { code: 128, stdout: '' }
    ]) {
      const runProcess = vi.fn(async () => result)
      await expect(hasNoChangedFiles(['run', '--changed'], '/repo', runProcess)).resolves.toBe(
        false
      )
    }
  })

  it.each([
    [['run', 'src/a']],
    [['run', '--changed', 'src/a']],
    [['run', '--changed', '--watch']],
    [['related', '--changed']]
  ])('leaves %j to Vitest', async (args) => {
    const runProcess = clean()
    await expect(hasNoChangedFiles(args, '/repo', runProcess)).resolves.toBe(false)
    expect(runProcess).not.toHaveBeenCalled()
  })
})
