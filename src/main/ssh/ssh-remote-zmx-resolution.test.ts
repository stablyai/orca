import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))

import { execCommand } from './ssh-relay-deploy-helpers'
import { resolveRemoteZmxPath } from './ssh-remote-zmx-resolution'
import type { SshConnection } from './ssh-connection'

describe('resolveRemoteZmxPath', () => {
  const conn = {} as SshConnection

  beforeEach(() => vi.mocked(execCommand).mockReset())

  it('finds Homebrew zmx outside the non-interactive SSH PATH', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('/opt/homebrew/bin/zmx\n')

    await expect(resolveRemoteZmxPath(conn)).resolves.toBe('/opt/homebrew/bin/zmx')
  })

  it('falls back to the configured login shell', async () => {
    vi.mocked(execCommand)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('/bin/zsh\n')
      .mockResolvedValueOnce('ORCA_ZMX_PATH:/custom/bin/zmx\n')

    await expect(resolveRemoteZmxPath(conn)).resolves.toBe('/custom/bin/zmx')
    expect(vi.mocked(execCommand).mock.calls[2]?.[2]).toMatchObject({ wrapCommand: false })
  })

  it('ignores absolute-path rc noise without the sentinel', async () => {
    // Why: dotfiles can print '/'-prefixed lines before command -v answers;
    // only the sentinel-marked executability-checked result may be trusted.
    vi.mocked(execCommand)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('/bin/zsh\n')
      .mockResolvedValueOnce('/home/user/dotfiles\n/etc/profile.d/motd\n')

    await expect(resolveRemoteZmxPath(conn)).rejects.toThrow('not found in the remote login PATH')
  })

  it('prefers the last sentinel line when rc noise fakes one', async () => {
    vi.mocked(execCommand)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('/bin/zsh\n')
      .mockResolvedValueOnce('ORCA_ZMX_PATH:/fake/rc/zmx\nORCA_ZMX_PATH:/real/bin/zmx\n')

    await expect(resolveRemoteZmxPath(conn)).resolves.toBe('/real/bin/zmx')
  })

  it('reports an actionable error when zmx is unavailable', async () => {
    vi.mocked(execCommand).mockResolvedValue('')

    await expect(resolveRemoteZmxPath(conn)).rejects.toThrow('not found in the remote login PATH')
  })
})
