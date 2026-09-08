import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearMobileWebColdResumeRoute,
  clearMobileWebColdResumeRouteForHost,
  loadMobileWebColdResumeRoute,
  mobileWebColdResumeStartupPath,
  saveMobileWebColdResumeRoute
} from './mobile-web-cold-resume-route'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn()
  }
}))

describe('mobile web cold resume route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('round-trips bounded native host and workspace identity', async () => {
    await saveMobileWebColdResumeRoute({
      hostIdentity: 'paired-host',
      hostWorkspaceIdentity: 'repo::/private/worktree'
    })
    const stored = vi.mocked(AsyncStorage.setItem).mock.calls[0]?.[1]
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(stored ?? null)

    await expect(loadMobileWebColdResumeRoute()).resolves.toEqual({
      hostIdentity: 'paired-host',
      hostWorkspaceIdentity: 'repo::/private/worktree'
    })
    expect(stored).not.toContain('deviceToken')
  })

  it('rejects malformed, empty, and oversized identities', async () => {
    for (const value of [
      '{',
      JSON.stringify({ version: 2, hostIdentity: 'host', hostWorkspaceIdentity: 'workspace' }),
      JSON.stringify({ version: 1, hostIdentity: '', hostWorkspaceIdentity: 'workspace' }),
      JSON.stringify({
        version: 1,
        hostIdentity: 'host',
        hostWorkspaceIdentity: 'x'.repeat(513)
      })
    ]) {
      vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce(value)
      await expect(loadMobileWebColdResumeRoute()).resolves.toBeNull()
    }
  })

  it('clears only the route owned by a removed paired host', async () => {
    vi.mocked(AsyncStorage.getItem)
      .mockResolvedValueOnce(
        JSON.stringify({
          version: 1,
          hostIdentity: 'other-host',
          hostWorkspaceIdentity: 'workspace'
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          version: 1,
          hostIdentity: 'removed-host',
          hostWorkspaceIdentity: 'workspace'
        })
      )

    await clearMobileWebColdResumeRouteForHost('removed-host')
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled()
    await clearMobileWebColdResumeRouteForHost('removed-host')
    expect(AsyncStorage.removeItem).toHaveBeenCalledOnce()

    await clearMobileWebColdResumeRoute()
    expect(AsyncStorage.removeItem).toHaveBeenCalledTimes(2)
  })

  it('enters Hybrid only from app root when the paired host still exists', () => {
    const route = {
      hostIdentity: 'paired-host',
      hostWorkspaceIdentity: 'workspace'
    }
    expect(mobileWebColdResumeStartupPath(route, [{ id: 'paired-host' }], '/')).toBe(
      '/hybrid?hostId=paired-host'
    )
    expect(mobileWebColdResumeStartupPath(route, [{ id: 'paired-host' }], '/', true)).toBeNull()
    expect(mobileWebColdResumeStartupPath(route, [{ id: 'other-host' }], '/')).toBeNull()
    for (const nativePath of [
      '/settings',
      '/terminal-settings',
      '/native-chat-settings',
      '/browser-settings',
      '/voice-settings',
      '/notifications',
      '/troubleshoot',
      '/connection-log',
      '/about',
      '/mobile-onboarding'
    ]) {
      expect(mobileWebColdResumeStartupPath(route, [{ id: 'paired-host' }], nativePath)).toBeNull()
    }
  })
})
