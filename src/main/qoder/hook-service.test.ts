import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  homedirMock,
  readHooksJsonRemoteMock,
  writeHooksJsonRemoteMock,
  writeManagedScriptRemoteMock
} = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  readHooksJsonRemoteMock: vi.fn(),
  writeHooksJsonRemoteMock: vi.fn(),
  writeManagedScriptRemoteMock: vi.fn()
}))

vi.mock('node:os', async () => {
  const actual = (await vi.importActual('node:os')) as Record<string, unknown>
  return { ...actual, homedir: homedirMock }
})

vi.mock('../agent-hooks/installer-utils-remote', () => ({
  readHooksJsonRemote: readHooksJsonRemoteMock,
  writeHooksJsonRemote: writeHooksJsonRemoteMock,
  writeManagedScriptRemote: writeManagedScriptRemoteMock
}))

import { QoderHookService } from './hook-service'

describe('QoderHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-qoder-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('installs PermissionRequest so Qoder approval prompts reach Orca', () => {
    const service = new QoderHookService()

    expect(service.install()).toMatchObject({
      state: 'installed',
      managedHooksPresent: true
    })

    const config = JSON.parse(readFileSync(join(homeDir, '.qoder', 'settings.json'), 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    expect(config.hooks.PermissionRequest).toHaveLength(1)
    expect(config.hooks.PermissionRequest[0].matcher).toBe('.*')
    expect(config.hooks.PermissionRequest[0].hooks[0].command).toContain('qoder-hook')
    expect(service.getStatus().state).toBe('installed')
  })

  it('normalizes POSIX paths when installing hooks on a remote host', async () => {
    readHooksJsonRemoteMock.mockResolvedValue({ hooks: {} })
    const sftp = {} as SFTPWrapper

    const status = await new QoderHookService().installRemote(sftp, '/home/dev//')

    expect(status).toMatchObject({
      state: 'installed',
      configPath: '/home/dev/.qoder/settings.json'
    })
    expect(readHooksJsonRemoteMock).toHaveBeenCalledWith(sftp, '/home/dev/.qoder/settings.json')
    expect(writeManagedScriptRemoteMock).toHaveBeenCalledWith(
      sftp,
      '/home/dev/.orca/agent-hooks/qoder-hook.sh',
      expect.any(String)
    )
    expect(writeHooksJsonRemoteMock).toHaveBeenCalledWith(
      sftp,
      '/home/dev/.qoder/settings.json',
      expect.any(Object)
    )
  })
})
