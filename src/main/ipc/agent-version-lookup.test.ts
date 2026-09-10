import { describe, expect, it, vi } from 'vitest'
import { resolveClaudeLatestVersion } from './agent-version-lookup'

describe('agent version lookup', () => {
  it('reads the configured Claude release channel without installing it', async () => {
    const requester = vi.fn(async () => 'v2.1.220\n')

    await expect(resolveClaudeLatestVersion('stable', requester)).resolves.toBe('2.1.220')
    expect(requester).toHaveBeenCalledWith(expect.stringMatching(/claude-code-releases\/stable$/))
  })

  it('ignores malformed release responses', async () => {
    await expect(resolveClaudeLatestVersion('latest', async () => 'not-a-version')).resolves.toBe(
      null
    )
  })
})
