import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  statMock,
  writeFileMock,
  remoteStatMock,
  remoteWriteFileMock,
  remoteWriteFileBase64Mock,
  remoteWritePrivateFileBase64Mock,
  requireSshFilesystemProviderMock
} = vi.hoisted(() => ({
  statMock: vi.fn<(path: string) => Promise<unknown>>(),
  writeFileMock: vi.fn<(path: string, data: string, options: unknown) => Promise<void>>(),
  remoteStatMock: vi.fn(),
  remoteWriteFileMock: vi.fn(),
  remoteWriteFileBase64Mock: vi.fn(),
  remoteWritePrivateFileBase64Mock: vi.fn(),
  requireSshFilesystemProviderMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  default: {
    stat: statMock,
    writeFile: writeFileMock
  }
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/desktop-host') }
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: requireSshFilesystemProviderMock
}))

import { ensureAgentSessionRulesFile } from './agent-session-rules-file'

describe('ensureAgentSessionRulesFile', () => {
  beforeEach(() => {
    statMock.mockReset()
    writeFileMock.mockReset()
    remoteStatMock.mockReset()
    remoteWriteFileMock.mockReset()
    remoteWriteFileBase64Mock.mockReset()
    remoteWritePrivateFileBase64Mock.mockReset()
    requireSshFilesystemProviderMock.mockReset()
    requireSshFilesystemProviderMock.mockReturnValue({
      getTempDir: vi.fn().mockResolvedValue('/tmp'),
      stat: remoteStatMock,
      writeFile: remoteWriteFileMock,
      writeFileBase64: remoteWriteFileBase64Mock,
      writePrivateFileBase64: remoteWritePrivateFileBase64Mock
    })
  })

  it('returns null without touching the filesystem when rules text is empty', async () => {
    await expect(ensureAgentSessionRulesFile('', { wslDistro: 'Ubuntu' })).resolves.toBeNull()
    expect(statMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('writes through the WSL UNC share but returns the Linux-side path', async () => {
    statMock.mockRejectedValueOnce(new Error('ENOENT'))
    writeFileMock.mockResolvedValueOnce(undefined)

    const result = await ensureAgentSessionRulesFile('rules text', { wslDistro: 'Ubuntu' })

    expect(result).toMatch(/^\/tmp\/orca-agent-session-rules-.*\.md$/)
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\\\\wsl\.localhost\\Ubuntu\\tmp\\orca-agent-session-rules-.*\.md$/),
      'rules text',
      { encoding: 'utf-8', flag: 'wx', mode: 0o600 }
    )
  })

  it('uses an unpredictable exclusive path instead of trusting an existing WSL cache file', async () => {
    writeFileMock.mockResolvedValueOnce(undefined)

    const result = await ensureAgentSessionRulesFile('rules text', { wslDistro: 'Ubuntu' })

    expect(result).toMatch(/^\/tmp\/orca-agent-session-rules-/)
    expect(statMock).not.toHaveBeenCalled()
    expect(writeFileMock).toHaveBeenCalledOnce()
  })

  it('falls back to the desktop host temp dir when no connection or distro is given', async () => {
    statMock.mockRejectedValueOnce(new Error('ENOENT'))
    writeFileMock.mockResolvedValueOnce(undefined)

    const result = await ensureAgentSessionRulesFile('rules text', {})

    expect(result).toMatch(/^\/tmp\/desktop-host\/orca-agent-session-rules-.*\.md$/)
    expect(writeFileMock).toHaveBeenCalledWith(result, 'rules text', {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600
    })
  })

  it('creates local rules files exclusively with private permissions', async () => {
    writeFileMock.mockResolvedValueOnce(undefined)

    const result = await ensureAgentSessionRulesFile('private rules', {})

    expect(writeFileMock).toHaveBeenCalledWith(result, 'private rules', {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600
    })
  })

  it('uses an exclusive remote write instead of trusting a predictable cached path', async () => {
    remoteWritePrivateFileBase64Mock.mockResolvedValueOnce(undefined)

    const result = await ensureAgentSessionRulesFile('remote rules', { connectionId: 'ssh-a' })

    expect(result).toMatch(/^\/tmp\/orca-agent-session-rules-.*\.md$/)
    expect(remoteStatMock).not.toHaveBeenCalled()
    expect(remoteWritePrivateFileBase64Mock).toHaveBeenCalledWith(
      result,
      Buffer.from('remote rules').toString('base64')
    )
    expect(remoteWriteFileBase64Mock).not.toHaveBeenCalled()
    expect(remoteWriteFileMock).not.toHaveBeenCalled()
  })
})
