import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { detectSkillProvidersInWsl } from './skill-wsl-provider-detection'

type RunWslProcessSpec = { distro: string; lane: string; script: string }

describe('detectSkillProvidersInWsl', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs on the probe lane so a PATH-only install (nvm/mise) is still found (regression)', async () => {
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
    expect(spec.lane).toBe('probe')
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
