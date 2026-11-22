import { describe, expect, it } from 'vitest'
import { isUnsafeAgentStartupCwd } from './default-cwd'

describe('isUnsafeAgentStartupCwd', () => {
  it('treats a WSL drive mount root as the whole drive for an agent', () => {
    expect(isUnsafeAgentStartupCwd('\\\\wsl.localhost\\Ubuntu\\mnt\\c', 'claude --resume 1')).toBe(
      true
    )
    expect(
      isUnsafeAgentStartupCwd('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\repo', 'claude --resume 1')
    ).toBe(false)
  })
})
