import { beforeEach, expect, it, vi } from 'vitest'

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

it('keeps a trailing empty PATH entry when prepending the program directory', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  vi.stubEnv('PATH', '/opt/tools:/usr/bin:')
  mocks.resolveCliCommandAsync.mockResolvedValue('/opt/tools/openclaw')

  try {
    await runLocalAutomationCommand('openclaw', ['cron', 'list'])

    expect(mocks.runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/opt/tools/openclaw',
        env: expect.objectContaining({ PATH: '/opt/tools:/usr/bin:' })
      })
    )
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    vi.unstubAllEnvs()
  }
})
