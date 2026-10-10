import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'

const mocks = vi.hoisted(() => ({
  getActiveSshAiVaultHostInfos: vi.fn(),
  getActiveSshAiVaultHostInfo: vi.fn(),
  getSshFilesystemProvider: vi.fn(),
  scanSshAiVaultSessions: vi.fn()
}))

vi.mock('../ipc/ssh', () => ({
  getActiveSshAiVaultHostInfos: mocks.getActiveSshAiVaultHostInfos,
  getActiveSshAiVaultHostInfo: mocks.getActiveSshAiVaultHostInfo
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: mocks.getSshFilesystemProvider
}))
vi.mock('./ssh-session-list', () => ({ scanSshAiVaultSessions: mocks.scanSshAiVaultSessions }))

import { resetAiVaultHostLegCacheForTests } from '../ipc/ai-vault-host-leg-cache'
import { aiVaultListCacheKey } from './ai-vault-list-cache-key'
import {
  isActiveSshAiVaultTarget,
  listSshHostScopeAiVaultSessions,
  probeWslTranscriptOnSshHost
} from './ssh-host-scope'

const RESULT: AiVaultListResult = { sessions: [], issues: [], scannedAt: '2026-10-09T00:00:00Z' }
const WSL_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\p\\s.jsonl'

function activeHost(pathFlavor: 'posix' | 'windows' = 'posix') {
  const info = { targetId: 'builder', hostPlatform: { pathFlavor } }
  mocks.getActiveSshAiVaultHostInfos.mockReturnValue([info])
  mocks.getActiveSshAiVaultHostInfo.mockReturnValue(info)
}

beforeEach(() => {
  vi.resetAllMocks()
  resetAiVaultHostLegCacheForTests()
  mocks.getActiveSshAiVaultHostInfos.mockReturnValue([])
  mocks.scanSshAiVaultSessions.mockResolvedValue(RESULT)
})

describe('SSH host scope validation', () => {
  it('knows only targets the process holds a live relay for', () => {
    activeHost()
    expect(isActiveSshAiVaultTarget('builder')).toBe(true)
    expect(isActiveSshAiVaultTarget('other')).toBe(false)
  })

  it('treats a throwing enumerator as no active target', () => {
    mocks.getActiveSshAiVaultHostInfos.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(isActiveSshAiVaultTarget('builder')).toBe(false)
  })

  it('refuses to scan a target that is not connected', async () => {
    await expect(listSshHostScopeAiVaultSessions('attacker-chosen', {})).rejects.toThrow(
      /not connected/
    )
    expect(mocks.scanSshAiVaultSessions).not.toHaveBeenCalled()
  })

  it('scans a connected target and serves the repeat from the host-leg cache', async () => {
    activeHost()
    await listSshHostScopeAiVaultSessions('builder', { limit: 5, scopePaths: ['/home/ada/app'] })
    await listSshHostScopeAiVaultSessions('builder', { limit: 5, scopePaths: ['/home/ada/app'] })
    expect(mocks.scanSshAiVaultSessions).toHaveBeenCalledTimes(1)
    expect(mocks.scanSshAiVaultSessions).toHaveBeenCalledWith(
      'builder',
      expect.objectContaining({ limit: 5 }),
      expect.anything()
    )
  })

  it('shares the desktop IPC cache key for the same scope', () => {
    expect(aiVaultListCacheKey({ executionHostScope: 'ssh:builder' })).toBe(
      aiVaultListCacheKey({}, 'ssh:builder')
    )
  })
})

describe('probeWslTranscriptOnSshHost', () => {
  it('reports present for a file at the translated path', async () => {
    activeHost()
    const stat = vi.fn().mockResolvedValue({ type: 'file', size: 1, mtime: 1 })
    mocks.getSshFilesystemProvider.mockReturnValue({ stat })
    await expect(probeWslTranscriptOnSshHost('builder', WSL_PATH)).resolves.toBe('present')
    expect(stat).toHaveBeenCalledWith('/home/ada/.claude/projects/p/s.jsonl')
  })

  it('reports missing on ENOENT and for a directory', async () => {
    activeHost()
    const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    mocks.getSshFilesystemProvider.mockReturnValue({ stat: vi.fn().mockRejectedValue(enoent) })
    await expect(probeWslTranscriptOnSshHost('builder', WSL_PATH)).resolves.toBe('missing')
    mocks.getSshFilesystemProvider.mockReturnValue({
      stat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtime: 1 })
    })
    await expect(probeWslTranscriptOnSshHost('builder', WSL_PATH)).resolves.toBe('missing')
  })

  it('stays unverifiable for transport errors, a Windows host and a missing provider', async () => {
    activeHost()
    mocks.getSshFilesystemProvider.mockReturnValue({
      stat: vi.fn().mockRejectedValue(new Error('Remote connection dropped'))
    })
    await expect(probeWslTranscriptOnSshHost('builder', WSL_PATH)).resolves.toBe('unverifiable')
    mocks.getSshFilesystemProvider.mockReturnValue(undefined)
    await expect(probeWslTranscriptOnSshHost('builder', WSL_PATH)).resolves.toBe('unverifiable')
    activeHost('windows')
    mocks.getSshFilesystemProvider.mockReturnValue({ stat: vi.fn() })
    await expect(probeWslTranscriptOnSshHost('builder', WSL_PATH)).resolves.toBe('unverifiable')
  })

  it('refuses a target that is not connected and never stats a non-WSL path', async () => {
    await expect(probeWslTranscriptOnSshHost('nope', WSL_PATH)).rejects.toThrow(/not connected/)
    activeHost()
    const stat = vi.fn()
    mocks.getSshFilesystemProvider.mockReturnValue({ stat })
    await expect(probeWslTranscriptOnSshHost('builder', '/etc/passwd')).resolves.toBe(
      'unverifiable'
    )
    expect(stat).not.toHaveBeenCalled()
  })
})
