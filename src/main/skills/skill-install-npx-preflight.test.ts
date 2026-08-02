import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hydrateShellPath: vi.fn(),
  isCommandOnPath: vi.fn(),
  mergePathSegments: vi.fn(),
  mergePersistedWindowsPath: vi.fn(),
  refreshShellPath: vi.fn()
}))

vi.mock('../ipc/agent-detection-shell-path', () => ({
  hydrateShellPathForAgentDetection: mocks.hydrateShellPath
}))

vi.mock('../ipc/preflight-command-exec', () => ({
  isCommandOnPath: mocks.isCommandOnPath
}))

vi.mock('../pty/windows-environment-path', () => ({
  mergePersistedWindowsPathAsync: mocks.mergePersistedWindowsPath
}))

vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: mocks.refreshShellPath,
  mergePathSegments: mocks.mergePathSegments
}))

import { isNpxOnPathForSkillInstall } from './skill-install-npx-preflight'

describe('isNpxOnPathForSkillInstall', () => {
  beforeEach(() => {
    mocks.hydrateShellPath.mockReset()
    mocks.hydrateShellPath.mockResolvedValue(undefined)
    mocks.isCommandOnPath.mockReset()
    mocks.isCommandOnPath.mockResolvedValue(true)
    mocks.mergePathSegments.mockReset()
    mocks.mergePersistedWindowsPath.mockReset()
    mocks.mergePersistedWindowsPath.mockResolvedValue(undefined)
    mocks.refreshShellPath.mockReset()
    mocks.refreshShellPath.mockResolvedValue({
      ok: true,
      segments: ['/fresh/bin'],
      failureReason: 'none'
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('hydrates and checks the local host PATH', async () => {
    await expect(isNpxOnPathForSkillInstall()).resolves.toBe(true)

    expect(mocks.hydrateShellPath).toHaveBeenCalledWith(undefined)
    expect(mocks.isCommandOnPath).toHaveBeenCalledWith('npx', undefined)
  })

  it('checks the selected WSL distro on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const context = { wslDistro: 'Ubuntu' }

    await expect(isNpxOnPathForSkillInstall(context)).resolves.toBe(true)

    expect(mocks.hydrateShellPath).not.toHaveBeenCalled()
    expect(mocks.mergePersistedWindowsPath).not.toHaveBeenCalled()
    expect(mocks.isCommandOnPath).toHaveBeenCalledWith('npx', { distro: 'Ubuntu' })
  })

  it('awaits the asynchronous Windows PATH merge before the initial host check', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    let finishPathMerge: (() => void) | undefined
    mocks.mergePersistedWindowsPath.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPathMerge = resolve
        })
    )

    const check = isNpxOnPathForSkillInstall()
    await Promise.resolve()

    expect(mocks.isCommandOnPath).not.toHaveBeenCalled()
    expect(mocks.mergePersistedWindowsPath).toHaveBeenCalledWith(process.env, {
      forceRefresh: false
    })
    finishPathMerge?.()
    await expect(check).resolves.toBe(true)
    expect(mocks.isCommandOnPath).toHaveBeenCalledWith('npx', undefined)
  })

  it('checks the default WSL distro without refreshing the Windows host PATH', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    await expect(
      isNpxOnPathForSkillInstall({ wslDefault: true }, { forceRefresh: true })
    ).resolves.toBe(true)

    expect(mocks.mergePersistedWindowsPath).not.toHaveBeenCalled()
    expect(mocks.isCommandOnPath).toHaveBeenCalledWith('npx', {})
  })

  it('force-refreshes the POSIX login-shell PATH before a re-check', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    await expect(isNpxOnPathForSkillInstall(undefined, { forceRefresh: true })).resolves.toBe(true)

    expect(mocks.refreshShellPath).toHaveBeenCalledWith({ force: true })
    expect(mocks.mergePathSegments).toHaveBeenCalledWith(['/fresh/bin'])
    expect(mocks.hydrateShellPath).not.toHaveBeenCalled()
  })

  it('force-refreshes the persisted Windows PATH before a re-check', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    await expect(isNpxOnPathForSkillInstall(undefined, { forceRefresh: true })).resolves.toBe(true)

    expect(mocks.mergePersistedWindowsPath).toHaveBeenCalledWith(process.env, {
      forceRefresh: true
    })
    expect(mocks.hydrateShellPath).not.toHaveBeenCalled()
  })
})
