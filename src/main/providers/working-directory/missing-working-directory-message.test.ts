import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { readMissingWorkingDirectory } from '../../../shared/terminal/pty/lifecycle/missing-working-directory-message'
import { validateWorkingDirectory } from './validation'

describe('missing working directory message', () => {
  it('names the folder the host refused, so a pane can wait for it to return', async () => {
    const missing = join(tmpdir(), 'orca-missing-volume-folder')
    const message = await validateWorkingDirectory(missing).then(
      () => '',
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : '')
    )
    expect(readMissingWorkingDirectory(message)).toBe(missing)
  })

  it('ignores other spawn failures', () => {
    expect(readMissingWorkingDirectory('Working directory "/a" is not a directory.')).toBeNull()
  })
})
