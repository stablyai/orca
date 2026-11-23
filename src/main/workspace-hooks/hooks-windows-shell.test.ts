import type * as NodeChildProcess from 'node:child_process'
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repository/repo-types'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof NodeChildProcess>('node:child_process')
  return { ...actual, spawn: spawnMock }
})

import { runHook } from './hooks'

const originalPlatform = process.platform
const REPO: Repo = { id: 'r', path: 'C:\\repo', displayName: 'r', badgeColor: '#000', addedAt: 0 }

function createClosingChild(): ChildProcess {
  const child = new ChildProcess()
  Object.defineProperties(child, {
    stdin: { value: new PassThrough(), configurable: true },
    stdout: { value: new PassThrough(), configurable: true },
    stderr: { value: new PassThrough(), configurable: true }
  })
  queueMicrotask(() => {
    child.emit('close', 0, null)
  })
  return child
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.unstubAllEnvs()
  spawnMock.mockReset()
})

it('falls back to System32 cmd.exe when ComSpec is unset or blank on Windows', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('SystemRoot', 'D:\\Windows')
  vi.stubEnv('ComSpec', '   ')
  vi.stubEnv('COMSPEC', '   ')
  spawnMock.mockImplementationOnce(() => createClosingChild())

  const result = await runHook('setup', 'C:\\repo\\wt', REPO, undefined, undefined, {
    hooks: { scripts: { setup: 'echo hi' } }
  })

  expect(result.success).toBe(true)
  expect(spawnMock).toHaveBeenCalledWith(
    'echo hi',
    expect.objectContaining({ shell: 'D:\\Windows\\System32\\cmd.exe' })
  )
})

it('uses ComSpec when set on Windows', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('ComSpec', 'E:\\Custom\\cmd.exe')
  spawnMock.mockImplementationOnce(() => createClosingChild())

  const result = await runHook('setup', 'C:\\repo\\wt', REPO, undefined, undefined, {
    hooks: { scripts: { setup: 'echo hi' } }
  })

  expect(result.success).toBe(true)
  expect(spawnMock).toHaveBeenCalledWith(
    'echo hi',
    expect.objectContaining({ shell: 'E:\\Custom\\cmd.exe' })
  )
})
