import { describe, expect, it, vi } from 'vitest'
import { toHostReadableTranscriptPath } from './host-readable-transcript-path'

const GUEST_PATH = '/home/ada/.codex/sessions/rollout.jsonl'
const DEBIAN_PATH = '\\\\wsl.localhost\\Debian\\home\\ada\\.codex\\sessions\\rollout.jsonl'
const UBUNTU_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout.jsonl'
const HOMES = ['\\\\wsl.localhost\\Debian\\home\\ada', '\\\\wsl.localhost\\Ubuntu\\home\\ada']

describe('native-chat PTY provenance oracle', () => {
  it('routes known WSL provenance directly to its owning distro', async () => {
    const enumerate = vi.fn(async () => HOMES)
    const probe = vi.fn(async () => true)

    await expect(
      toHostReadableTranscriptPath(GUEST_PATH, {
        platform: 'win32',
        transcriptHost: { kind: 'wsl', distro: 'Ubuntu' },
        listWslHomeDirs: enumerate,
        pathExists: probe
      })
    ).resolves.toBe(UBUNTU_PATH)
    expect(enumerate).not.toHaveBeenCalled()
    expect(probe).toHaveBeenCalledWith(UBUNTU_PATH)
  })

  it('keeps host provenance out of WSL', async () => {
    const enumerate = vi.fn(async () => HOMES)
    const probe = vi.fn(async () => true)

    await expect(
      toHostReadableTranscriptPath(GUEST_PATH, {
        platform: 'win32',
        transcriptHost: { kind: 'host' },
        listWslHomeDirs: enumerate,
        pathExists: probe
      })
    ).resolves.toBeNull()
    expect(enumerate).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  it('preserves broad recovery only when provenance is unavailable', async () => {
    await expect(
      toHostReadableTranscriptPath(GUEST_PATH, {
        platform: 'win32',
        listWslHomeDirs: async () => HOMES,
        pathExists: async () => true
      })
    ).resolves.toBe(DEBIAN_PATH)
  })

  it('rejects a WSL device path for host provenance before probing', async () => {
    const extended = '\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout.jsonl'
    const probe = vi.fn(async () => true)

    await expect(
      toHostReadableTranscriptPath(extended, {
        platform: 'win32',
        transcriptHost: { kind: 'host' },
        pathExists: probe
      })
    ).resolves.toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })
})
