import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl/execution/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { detectSkillProvidersInWsl } from './skill-wsl-provider-detection'

describe('detectSkillProvidersInWsl', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses both providers when present', async () => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout: 'codex\nclaude\n',
      stderr: '',
      timedOut: false
    })

    const found = await detectSkillProvidersInWsl('Ubuntu')

    expect(found.toSorted()).toEqual(['claude', 'codex'])
  })

  it('ignores stray output that is not a recognized provider name', async () => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout: 'codex\nsomething-else\n',
      stderr: '',
      timedOut: false
    })

    const found = await detectSkillProvidersInWsl('Ubuntu')

    expect(found).toEqual(['codex'])
  })

  it.each([
    ['reports unverifiable rather than empty', '', true],
    ['reports unverifiable even on a partial hit', 'claude\n', true],
    ['still trusts a genuine empty result', '', false]
  ])('%s', async (_case, stdout, unresolved) => {
    // The script always exits 0; unresolved login PATH must not be mistaken for no installed providers (#9725).
    runWslProcessMock.mockResolvedValue({
      environmentResolved: !unresolved,
      code: 0,
      stdout,
      stderr: '',
      timedOut: false
    })

    await (unresolved
      ? expect(detectSkillProvidersInWsl('Ubuntu')).rejects.toThrow(
          'skill-install-wsl-provider-detection-failed'
        )
      : expect(detectSkillProvidersInWsl('Ubuntu')).resolves.toEqual(
          stdout.trim() ? ['claude'] : []
        ))
  })

  it('rejects when wsl.exe cannot be started', async () => {
    runWslProcessMock.mockRejectedValue(new Error('spawn wsl.exe ENOENT'))

    await expect(detectSkillProvidersInWsl('Ubuntu')).rejects.toThrow(
      'skill-install-wsl-provider-detection-failed'
    )
  })

  it('rejects on a non-zero exit', async () => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 1,
      stdout: '',
      stderr: 'distro is stopped',
      timedOut: false
    })

    await expect(detectSkillProvidersInWsl('Ubuntu')).rejects.toThrow(
      'skill-install-wsl-provider-detection-failed'
    )
  })
})
