import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findClaudeSessionFile } from './session-file-resolver-claude-probe'

// chmod can't deny reads on Windows or to root.
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'findClaudeSessionFile with an unreadable bucket',
  () => {
    let projectsDir: string
    let lockedBucket: string

    afterEach(async () => {
      await chmod(lockedBucket, 0o700)
      await rm(projectsDir, { recursive: true, force: true })
    })

    it('looks past it under strict errors', async () => {
      projectsDir = await mkdtemp(join(tmpdir(), 'claude-probe-'))
      lockedBucket = join(projectsDir, '-root-owned')
      await mkdir(lockedBucket)
      await chmod(lockedBucket, 0o000)
      await mkdir(join(projectsDir, '-work-repo'))
      await writeFile(join(projectsDir, '-work-repo', 'saved.jsonl'), '{}\n')
      const options = { cwd: '/elsewhere', strictErrors: true }

      await expect(findClaudeSessionFile(projectsDir, 'saved', options)).resolves.toBe(
        join(projectsDir, '-work-repo', 'saved.jsonl')
      )
      await expect(findClaudeSessionFile(projectsDir, 'unsaved', options)).resolves.toBeNull()
    })
  }
)
