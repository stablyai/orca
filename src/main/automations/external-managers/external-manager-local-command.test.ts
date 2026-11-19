import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))

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

it('spawns a Windows npm .cmd shim by its resolved path', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const shimPath = join(pathDir, 'orca-test-openclaw.cmd')
  await writeFile(shimPath, '@echo off\r\n')

  await runLocalAutomationCommand('orca-test-openclaw', ['cron', 'run', 'job-42'])

  // runProcess launches .cmd shims only when the program carries the extension.
  expect(runProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      program: shimPath,
      args: ['cron', 'run', 'job-42']
    })
  )
})

it('discovers commands with System32 where.exe, not a PATH lookup of where', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  await writeFile(join(pathDir, 'where.cmd'), '@echo off\r\n')

  await expect(isExternalAutomationCommandOnPath('orca-test-openclaw')).resolves.toBe(true)

  expect(runProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      program: 'C:\\Windows\\System32\\where.exe',
      args: ['orca-test-openclaw']
    })
  )
})

it('spawns the bare name on Windows when PATH has no match', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })

  await runLocalAutomationCommand('orca-test-openclaw', ['cron', 'list'])

  expect(runProcess).toHaveBeenCalledWith(
    expect.objectContaining({ program: 'orca-test-openclaw' })
  )
})

it('leaves POSIX spawns to PATH lookup by bare name', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  const binary = join(pathDir, 'orca-test-openclaw')
  await writeFile(binary, '#!/bin/sh\n')
  await chmod(binary, 0o755)

  await runLocalAutomationCommand('orca-test-openclaw', ['cron', 'list'])

  expect(runProcess).toHaveBeenCalledWith(
    expect.objectContaining({ program: 'orca-test-openclaw' })
  )
})
