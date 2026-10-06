import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as LaunchPlanModule from './local-pty-launch-plan'
import type * as SpawnStateModule from './local-pty-spawn-state'
import { ptyShutdownOperations, type PtyShutdownOperation } from './local-pty-provider-state'
import type { WslLaunchDirectory } from '../../shared/wsl-launch-directory'

const { resolveSpawnWslLaunchDirectory, reattachLocalPty } = vi.hoisted(() => ({
  resolveSpawnWslLaunchDirectory: vi.fn(),
  reattachLocalPty: vi.fn()
}))
vi.mock('./wsl-launch-directory-resolution', () => ({ resolveSpawnWslLaunchDirectory }))
vi.mock('./local-pty-launch-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchPlanModule>()),
  resolveLocalPtyWslDistro: () => 'Ubuntu'
}))
vi.mock('./local-pty-spawn-state', async (importOriginal) => ({
  ...(await importOriginal<typeof SpawnStateModule>()),
  reattachLocalPty
}))

import { spawnLocalPty } from './local-pty-spawn'

afterEach(() => {
  ptyShutdownOperations.clear()
  vi.clearAllMocks()
})

describe('a WSL respawn racing a shutdown of the same session id', () => {
  // Why: the distro lookup awaits, so it must finish before the shutdown check; a shutdown that
  // starts during it would otherwise be missed and race the new PTY.
  it('waits for a shutdown that began while the distro directory was being resolved', async () => {
    let resolveDirectory!: (directory: WslLaunchDirectory | undefined) => void
    resolveSpawnWslLaunchDirectory.mockReturnValue(
      new Promise((resolve) => {
        resolveDirectory = resolve
      })
    )
    reattachLocalPty.mockReturnValue({ id: 'wsl-session' })
    const spawned = spawnLocalPty(
      { cols: 80, rows: 24, sessionId: 'wsl-session', command: 'claude' },
      () => ({})
    )
    await vi.waitFor(() =>
      expect(resolveSpawnWslLaunchDirectory).toHaveBeenCalledWith('Ubuntu', expect.anything())
    )

    let finishShutdown!: () => void
    const shutdown: PtyShutdownOperation = {
      promise: new Promise<void>((resolve) => {
        finishShutdown = resolve
      }),
      immediate: false,
      rootSignalled: false,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spawn under test only awaits `promise`; it never touches the shutting-down PTY.
      proc: {} as PtyShutdownOperation['proc']
    }
    ptyShutdownOperations.set('wsl-session', shutdown)
    resolveDirectory(undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reattachLocalPty).not.toHaveBeenCalled()

    finishShutdown()
    await expect(spawned).resolves.toEqual({ id: 'wsl-session' })
    expect(reattachLocalPty).toHaveBeenCalledOnce()
  })
})
