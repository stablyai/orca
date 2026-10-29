import { beforeEach, describe, expect, it, vi } from 'vitest'

const gate = vi.hoisted(() => ({ blocked: vi.fn() }))
vi.mock('../wsl/wsl-unc-access-gate', () => ({ blockedWslDistroForPath: gate.blocked }))

import { inactiveCodexHomeUnlessStopped } from './inactive-codex-home'

const WSL_HOME =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-accounts\\a\\home'

beforeEach(() => {
  gate.blocked.mockReset().mockResolvedValue(null)
})

describe('inactive Codex usage previews never boot a stopped WSL distro (E9)', () => {
  it('skips a WSL home whose distro is stopped or still stopping', async () => {
    gate.blocked.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
    await expect(
      inactiveCodexHomeUnlessStopped({ kind: 'ready', homePath: WSL_HOME })
    ).resolves.toEqual({ kind: 'skip' })
    expect(gate.blocked).toHaveBeenCalledWith(WSL_HOME)
  })

  it('previews a running distro and any host home', async () => {
    await expect(
      inactiveCodexHomeUnlessStopped({ kind: 'ready', homePath: WSL_HOME })
    ).resolves.toEqual({ kind: 'ready', managedHomePath: WSL_HOME })
    await expect(
      inactiveCodexHomeUnlessStopped({ kind: 'ready', homePath: 'C:\\Users\\ada\\codex' })
    ).resolves.toEqual({ kind: 'ready', managedHomePath: 'C:\\Users\\ada\\codex' })
  })

  it('keeps an untrusted home skipped', async () => {
    await expect(inactiveCodexHomeUnlessStopped({ kind: 'skip' })).resolves.toEqual({
      kind: 'skip'
    })
    expect(gate.blocked).not.toHaveBeenCalled()
  })
})
