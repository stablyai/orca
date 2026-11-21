import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as AsyncCommandResolution from '../../../shared/shell/command-resolution/node-cli-command-async-resolution'

const mocks = vi.hoisted(() => ({
  resolveCliCommandAsync: vi.fn(),
  resolveCommandOnLocalPath: vi.fn(),
  runProcess: vi.fn()
}))

vi.mock('../../../shared/shell/command-resolution/node-cli-command-async-resolution', () => ({
  resolveCliCommandAsync: mocks.resolveCliCommandAsync
}))
vi.mock('../../ipc/command-path/command-path-resolver', () => ({
  resolveCommandOnLocalPath: mocks.resolveCommandOnLocalPath
}))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))

import { resolvePathEnvKey } from '../../pty/environment/windows-path-segment-merge'
import {
  isExternalAutomationCommandOnPath,
  runLocalAutomationCommand
} from './external-manager-local-command'

const originalPlatform = process.platform

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveCliCommandAsync.mockResolvedValue('openclaw')
  mocks.resolveCommandOnLocalPath.mockResolvedValue(null)
  mocks.runProcess.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.unstubAllEnvs()
})

it('accepts an absolute resolver hit', async () => {
  mocks.resolveCliCommandAsync.mockResolvedValue('/opt/tools/openclaw')

  await expect(isExternalAutomationCommandOnPath('openclaw')).resolves.toBe(true)
})

it('accepts a relative PATH hit that normalises back to the bare name', async () => {
  mocks.resolveCommandOnLocalPath.mockResolvedValue('/work/openclaw')

  await expect(isExternalAutomationCommandOnPath('openclaw')).resolves.toBe(true)
})

it('rejects a genuine miss', async () => {
  mocks.resolveCliCommandAsync.mockResolvedValue('missing-test-cli')

  await expect(isExternalAutomationCommandOnPath('missing-test-cli')).resolves.toBe(false)
})

it('rejects when both resolvers fail', async () => {
  mocks.resolveCliCommandAsync.mockRejectedValue(new Error('lookup failed'))
  mocks.resolveCommandOnLocalPath.mockRejectedValue(new Error('lookup failed'))

  await expect(isExternalAutomationCommandOnPath('openclaw')).resolves.toBe(false)
})

it('keeps a trailing empty PATH entry when the program directory is already on PATH', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  vi.stubEnv('PATH', '/opt/tools:/usr/bin:')
  mocks.resolveCliCommandAsync.mockResolvedValue('/opt/tools/openclaw')

  await runLocalAutomationCommand('openclaw', ['cron', 'list'])

  expect(mocks.runProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      program: '/opt/tools/openclaw',
      env: expect.objectContaining({ PATH: '/opt/tools:/usr/bin:' })
    })
  )
})

it('appends an absent program directory after the inherited PATH entries', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  vi.stubEnv('PATH', '/usr/bin:/usr/local/bin')
  mocks.resolveCliCommandAsync.mockResolvedValue('/opt/cli/bin/openclaw')

  await runLocalAutomationCommand('openclaw', ['cron', 'list'])

  expect(mocks.runProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      env: expect.objectContaining({ PATH: '/usr/bin:/usr/local/bin:/opt/cli/bin' })
    })
  )
})

it('preserves inherited PATH order and repeated entries when the directory is present', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  vi.stubEnv('PATH', '/usr/bin:/opt/cli/bin:/usr/bin:')
  mocks.resolveCliCommandAsync.mockResolvedValue('/opt/cli/bin/openclaw')

  await runLocalAutomationCommand('openclaw', ['cron', 'list'])

  expect(mocks.runProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      env: expect.objectContaining({ PATH: '/usr/bin:/opt/cli/bin:/usr/bin:' })
    })
  )
})

it.skipIf(process.platform !== 'win32')(
  'matches a case-variant Windows PATH entry without trailing separators',
  async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.stubEnv('PATH', 'C:\\Tools\\;D:\\bin')
    mocks.resolveCliCommandAsync.mockResolvedValue('c:\\tools\\openclaw.cmd')

    await runLocalAutomationCommand('openclaw', ['cron', 'list'])

    const pathKey = resolvePathEnvKey(process.env, 'win32')
    expect(mocks.runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ [pathKey]: 'C:\\Tools\\;D:\\bin' })
      })
    )
  }
)

it('spawns the local-path shim when the CLI lookup misses', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('PATH', 'C:\\Tools')
  mocks.resolveCliCommandAsync.mockResolvedValue('openclaw')
  mocks.resolveCommandOnLocalPath.mockResolvedValue('C:\\Tools\\openclaw.cmd')

  await runLocalAutomationCommand('openclaw', ['cron', 'list'])

  expect(mocks.resolveCommandOnLocalPath).toHaveBeenCalledWith('openclaw')
  expect(mocks.runProcess).toHaveBeenCalledWith(
    expect.objectContaining({ program: 'C:\\Tools\\openclaw.cmd' })
  )
})

it.skipIf(process.platform === 'win32')(
  'discovers and executes a real executable in a relative PATH entry',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-local-command-'))
    const originalCwd = process.cwd()
    const inheritedPath = process.env.PATH ?? ''
    const command = `orca-relative-path-test-${process.pid}-${Date.now()}`
    const executablePath = join(cwd, command)

    try {
      await writeFile(executablePath, '#!/bin/sh\nexit 0\n')
      await chmod(executablePath, 0o755)
      process.chdir(cwd)
      vi.stubEnv('PATH', `.${delimiter}${inheritedPath}`)

      // ast-grep-ignore: test-no-in-test-import-actual -- This test deliberately loads the real resolver after filesystem setup.
      const actualResolver = await vi.importActual<typeof AsyncCommandResolution>(
        '../../../shared/shell/command-resolution/node-cli-command-async-resolution'
      )
      mocks.resolveCliCommandAsync.mockImplementation(actualResolver.resolveCliCommandAsync)

      await expect(isExternalAutomationCommandOnPath(command)).resolves.toBe(true)
      await expect(isExternalAutomationCommandOnPath(`${command}-missing`)).resolves.toBe(false)

      await runLocalAutomationCommand(command, [])
      expect(mocks.runProcess).toHaveBeenCalledWith(
        expect.objectContaining({ program: await realpath(executablePath) })
      )
    } finally {
      process.chdir(originalCwd)
      await rm(cwd, { recursive: true, force: true })
    }
  }
)
