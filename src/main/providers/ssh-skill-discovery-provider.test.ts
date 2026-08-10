import { describe, expect, it, vi } from 'vitest'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import {
  SshSkillDiscoveryProvider,
  SshSkillDiscoveryUnsupportedError
} from './ssh-skill-discovery-provider'

const VALID_RESULT = {
  skills: [
    {
      id: 'docs',
      name: 'docs',
      description: null,
      providers: ['agent-skills'],
      sourceKind: 'repo',
      sourceLabel: 'Repo skills',
      rootPath: '/remote/repo/.agents/skills',
      directoryPath: '/remote/repo/.agents/skills/docs',
      skillFilePath: '/remote/repo/.agents/skills/docs/SKILL.md',
      installed: true,
      fileCount: 1,
      updatedAt: null
    }
  ],
  sources: [
    {
      id: 'repo-agents',
      label: 'Repo skills',
      path: '/remote/repo/.agents/skills',
      sourceKind: 'repo',
      providers: ['agent-skills'],
      owner: null,
      exists: true
    }
  ],
  scannedAt: 12345
}

function providerWith(request: ReturnType<typeof vi.fn>): SshSkillDiscoveryProvider {
  return new SshSkillDiscoveryProvider('conn-1', { request } as unknown as SshChannelMultiplexer)
}

describe('SshSkillDiscoveryProvider', () => {
  it('sends one skills.discover request with cwd, signal, and a bounded timeout', async () => {
    const request = vi.fn().mockResolvedValue(VALID_RESULT)
    const controller = new AbortController()

    const result = await providerWith(request).discover('/remote/repo', {
      signal: controller.signal
    })

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      'skills.discover',
      { cwd: '/remote/repo' },
      { signal: controller.signal, timeoutMs: 9_000 }
    )
    expect(result.skills.map((skill) => skill.name)).toEqual(['docs'])
  })

  it('maps JSON-RPC method-not-found to the relay upgrade error', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Method not found: skills.discover'), { code: -32601 })
      )

    await expect(providerWith(request).discover('/remote/repo')).rejects.toBeInstanceOf(
      SshSkillDiscoveryUnsupportedError
    )
  })

  it('rejects malformed relay responses instead of trusting the frame', async () => {
    const malformed = {
      ...VALID_RESULT,
      skills: [{ ...VALID_RESULT.skills[0], fileCount: Number.POSITIVE_INFINITY }]
    }
    const request = vi.fn().mockResolvedValue(malformed)

    await expect(providerWith(request).discover('/remote/repo')).rejects.toThrow()
  })

  it('rejects oversized strings from the relay', async () => {
    const malformed = {
      ...VALID_RESULT,
      skills: [{ ...VALID_RESULT.skills[0], name: 'x'.repeat(10_000) }]
    }
    const request = vi.fn().mockResolvedValue(malformed)

    await expect(providerWith(request).discover('/remote/repo')).rejects.toThrow()
  })

  it('passes through other transport errors unchanged', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Request "skills.discover" timed out'))

    await expect(providerWith(request).discover('/remote/repo')).rejects.toThrow(
      'Request "skills.discover" timed out'
    )
  })
})
