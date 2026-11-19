import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))

import { resolvePathEnvKey } from '../../pty/environment/windows-path-segment-merge'
import {
  isExternalAutomationCommandOnPath,
  runLocalAutomationCommand
} from './external-manager-local-command'

const originalPlatform = process.platform
let pathDir: string

beforeEach(async () => {
  pathDir = await mkdtemp(join(tmpdir(), 'orca-ext-automation-'))
  vi.stubEnv('PATH', pathDir)
  vi.stubEnv('PATHEXT', '.EXE;.cmd')
  runProcess.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false })
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  await rm(pathDir, { recursive: true, force: true })
})

it('spawns a Windows npm .cmd shim by its resolved path with its directory on PATH', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const shimPath = join(pathDir, 'orca-test-openclaw.cmd')
  await writeFile(shimPath, '@echo off\r\n')

  await runLocalAutomationCommand('orca-test-openclaw', ['cron', 'run', 'job-42'])

  expect(runProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      program: shimPath,
      args: ['cron', 'run', 'job-42'],
      env: expect.objectContaining({
        [resolvePathEnvKey(process.env, 'win32')]: pathDir
      })
    })
  )
})

it('reports availability from resolution without spawning a lookup process', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  await writeFile(join(pathDir, 'orca-test-openclaw.cmd'), '@echo off\r\n')

  await expect(isExternalAutomationCommandOnPath('orca-test-openclaw')).resolves.toBe(true)
  expect(runProcess).not.toHaveBeenCalled()

  await expect(isExternalAutomationCommandOnPath('missing-test-cli')).resolves.toBe(false)
})

it('spawns the bare name with no env override when resolution finds nothing', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })

  await runLocalAutomationCommand('orca-test-openclaw', ['cron', 'list'])

  expect(runProcess).toHaveBeenCalledWith({
    program: 'orca-test-openclaw',
    args: ['cron', 'list'],
    timeoutMs: 30_000
  })
})

it('preserves timeout and error reporting for resolved commands', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  await writeFile(join(pathDir, 'orca-test-openclaw.cmd'), '@echo off\r\n')

  runProcess.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: true })
  await expect(runLocalAutomationCommand('orca-test-openclaw', ['cron'])).rejects.toThrow(
    'Local automation command timed out after 30000ms.'
  )

  runProcess.mockResolvedValueOnce({
    code: 2,
    stdout: '',
    stderr: '  no such job \n',
    timedOut: false
  })
  await expect(runLocalAutomationCommand('orca-test-openclaw', ['cron'])).rejects.toThrow(
    'no such job'
  )
})
