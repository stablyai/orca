import { describe, expect, it } from 'vitest'

import { assertSafeAgentStartupCwd } from './default-cwd'

const ROOT_REFUSAL = /requires a non-root workspace working directory/

describe('assertSafeAgentStartupCwd', () => {
  it('allows a drive root that is the workspace path, folding drive-letter case (#35193)', () => {
    expect(() => assertSafeAgentStartupCwd('D:\\', 'claude', 'd:\\')).not.toThrow()
  })

  it('allows a POSIX root that is the workspace path', () => {
    expect(() => assertSafeAgentStartupCwd('/', 'claude', '/')).not.toThrow()
  })

  it('refuses a root cwd outside the workspace path', () => {
    expect(() => assertSafeAgentStartupCwd('/', 'claude', '/home/u/repo')).toThrow(ROOT_REFUSAL)
  })

  it('refuses a root cwd when the workspace path is missing or empty', () => {
    expect(() => assertSafeAgentStartupCwd('/', 'claude', '')).toThrow(ROOT_REFUSAL)
    expect(() => assertSafeAgentStartupCwd('/', 'claude')).toThrow(ROOT_REFUSAL)
  })
})
