import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHomePaths from './codex-home-paths'

const { blockedWslDistroForPath, stateDir } = vi.hoisted(() => ({
  blockedWslDistroForPath: vi.fn(),
  stateDir: vi.fn(() => '/tmp/orca-test-backfill-state')
}))

vi.mock('../wsl/wsl-unc-access-gate', () => ({ blockedWslDistroForPath }))
vi.mock('./codex-home-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexHomePaths>()),
  getCodexSessionBackfillStateDirPath: stateDir
}))

import { startCodexSessionBackfillInBackground } from './codex-session-backfill'
import { startCodexSessionIndexHealInBackground } from './codex-session-index-heal'
import { isCodexSessionSourceHomeBlocked } from './codex-session-source-home-wsl-gate'

const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex'

describe('the host Codex session source home (E9)', () => {
  beforeEach(() => {
    blockedWslDistroForPath.mockReset()
    stateDir.mockClear()
  })

  it('is blocked only while its WSL distro is not confirmed running', async () => {
    await expect(isCodexSessionSourceHomeBlocked(undefined)).resolves.toBe(false)
    expect(blockedWslDistroForPath).not.toHaveBeenCalled()
    blockedWslDistroForPath.mockResolvedValueOnce({ distro: 'Ubuntu', state: 'stopped' })
    await expect(isCodexSessionSourceHomeBlocked(WSL_HOME)).resolves.toBe(true)
    blockedWslDistroForPath.mockResolvedValueOnce({ distro: 'Ubuntu', state: 'unverifiable' })
    await expect(isCodexSessionSourceHomeBlocked(WSL_HOME)).resolves.toBe(true)
    blockedWslDistroForPath.mockResolvedValueOnce(null)
    await expect(isCodexSessionSourceHomeBlocked(WSL_HOME)).resolves.toBe(false)
    expect(blockedWslDistroForPath).toHaveBeenCalledWith(WSL_HOME)
  })

  it('a background backfill into a stopped distro’s home stops before touching any path', async () => {
    blockedWslDistroForPath.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
    const summary = await startCodexSessionBackfillInBackground({}, WSL_HOME)
    // Stopped keeps the scheduler's dates pending and skips the index heal.
    expect(summary).toMatchObject({ stopped: true, scannedFiles: 0, linkedFiles: 0 })
    expect(stateDir).not.toHaveBeenCalled()
  })

  it('the index heal never starts its app-server against a stopped distro’s home', async () => {
    blockedWslDistroForPath.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
    await expect(startCodexSessionIndexHealInBackground({}, WSL_HOME)).resolves.toBeNull()
    expect(stateDir).not.toHaveBeenCalled()
  })
})
