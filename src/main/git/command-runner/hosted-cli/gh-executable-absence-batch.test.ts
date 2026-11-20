import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { GhExecutableAbsenceBatch } from './gh-executable-absence-batch'

it('shares gh absence on Windows when PATH has a quoted entry and a trailing semicolon', async () => {
  const platform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', { value: platform })
  })
  const cwd = await mkdtemp(join(tmpdir(), 'orca-gh-absence-'))
  onTestFinished(() => rm(cwd, { recursive: true, force: true }))
  const command = { binary: 'gh', args: ['repo', 'view'], cwd, wsl: null, wslMode: null }
  const env = { Path: '"C:\\Orca Missing\\GitHub CLI";C:\\Orca Missing\\bin;', PATHEXT: '.EXE' }
  const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })

  const batch = new GhExecutableAbsenceBatch()
  onTestFinished(() => batch.close())
  await batch.run(async () => {
    await GhExecutableAbsenceBatch.recordMissing(command, env, missing)
    await expect(GhExecutableAbsenceBatch.assertAvailable(command, env)).rejects.toBe(missing)
  })
})
