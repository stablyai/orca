import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type * as ChildProcessModule from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'

const { execFileSpy } = vi.hoisted(() => ({ execFileSpy: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  execFileSpy.mockImplementation(actual.execFile)
  return { ...actual, execFile: execFileSpy }
})

import { gitExecFileAsync } from './git-exec-file'

let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('stops spawning Git in a deleted folder and resumes once it returns', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orca-missing-git-cwd-'))
  const cwd = path.join(root, 'repo')
  vi.spyOn(console, 'warn').mockImplementation(() => {})

  await expect(gitExecFileAsync(['status'], { cwd })).rejects.toMatchObject({ code: 'ENOENT' })
  expect(execFileSpy).toHaveBeenCalledTimes(1)

  await expect(gitExecFileAsync(['status'], { cwd })).rejects.toMatchObject({
    code: 'ENOENT',
    syscall: 'spawn git'
  })
  expect(execFileSpy).toHaveBeenCalledTimes(1)

  await mkdir(cwd)
  await gitExecFileAsync(['status'], { cwd }).catch(() => undefined)
  expect(execFileSpy).toHaveBeenCalledTimes(2)
})
