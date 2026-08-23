import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { detectSkillProvidersInWsl } from './skill-wsl-provider-detection'

type RunWslProcessSpec = { distro: string; loginPath: string; script: string }

describe('detectSkillProvidersInWsl', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('asks for the login PATH so a nvm/mise-only install is still found (regression)', async () => {
    // Before this migration the site ran `sh -c` with no login shell, so an
    // nvm-installed codex/claude -- reachable only through the PATH a login
    // shell assembles from rc files -- resolved to nothing via `command -v`
    // and read as not installed.
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout: 'codex\n',
      stderr: '',
      timedOut: false
    })

    const found = await detectSkillProvidersInWsl('Ubuntu')

    const [spec] = runWslProcessMock.mock.calls.at(-1) as [RunWslProcessSpec]
    expect(spec.loginPath).toBe('preferred')
    expect(spec.distro).toBe('Ubuntu')
    expect(found).toEqual(['codex'])
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

    expect(found).toEqual(['codex', 'claude'])
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
    // The script ends in `|| true`, so "ran without the login PATH" and "no
    // providers installed" are the same exit 0 with the same empty stdout.
    // Callers skip the ~/.codex and ~/.claude skill roots on an empty list, so
    // conflating them loses an nvm-installed provider's skills (#9725).
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
