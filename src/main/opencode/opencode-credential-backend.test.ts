import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { resolveCommandOnLocalPath } from '../ipc/command-path/command-path-resolver'
import {
  detectOpenCodeCredentialBackend,
  resetOpenCodeCredentialBackendProbes
} from './opencode-credential-backend'

const files = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
vi.mock('../ipc/command-path/command-path-resolver', () => ({ resolveCommandOnLocalPath: vi.fn() }))
vi.mock('node:fs/promises', () => files)

describe('OpenCode credential execution backend', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    resetOpenCodeCredentialBackendProbes()
    files.realpath.mockImplementation(async (path: string) => path)
    files.stat.mockResolvedValue({ dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 })
    vi.mocked(resolveCommandOnLocalPath).mockResolvedValue('/task/bin/opencode')
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '1.18.30\n',
      stderr: '',
      timedOut: false
    })
  })

  it('reprobes when the resolved binary is replaced', async () => {
    expect(await detectOpenCodeCredentialBackend()).toBe('v1')
    files.stat.mockResolvedValue({ dev: 1, ino: 6, size: 3, mtimeMs: 7, ctimeMs: 8 })
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'opencode v2.0.16',
      stderr: '',
      timedOut: false
    })

    expect(await detectOpenCodeCredentialBackend()).toBe('v2')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })
})
