import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { detectWslCommandsOnPath } from './preflight-wsl-agent-detection'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'

type RunWslProcessSpec = { distro?: string; lane: string; script: string }

function lastSpec(): RunWslProcessSpec {
  const call = runWslProcessMock.mock.calls.at(-1)
  expect(call).toBeDefined()
  return (call as [RunWslProcessSpec])[0]
}

describe('detectWslCommandsOnPath', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
    runWslProcessMock.mockResolvedValue({ environmentResolved: true, code: 0, stdout: '', stderr: '', timedOut: false })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs on the probe lane -- no shell, so no rc/motd banner can appear', async () => {
    await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])

    const spec = lastSpec()
    expect(spec.lane).toBe('probe')
    expect(spec.distro).toBe('Ubuntu')
  })

  it('builds a probe script with no `fi done` (zsh parse error) sequence', async () => {
    await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])

    const { script } = lastSpec()
    // Why: zsh aborts on `fi done` — the loop body and `done` must be separated
    // by a newline. Regression guard for issue #5325.
    expect(script).not.toContain('fi done')
    expect(script).toContain('fi\ndone')
  })

  it('uses the shared alias- and function-neutral PATH lookup', async () => {
    await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])

    const { script } = lastSpec()
    const lookupScript = buildPosixCommandPathLookupScript({
      kind: 'shell-variable',
      name: 'cmd'
    })
    expect(script).toContain(lookupScript)
    expect(script).not.toContain('type -P')
  })

  it('parses detected commands from prefixed stdout', async () => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout:
        '__ORCA_AGENT_PATH__claude\t/usr/bin/claude\n' +
        '__ORCA_AGENT_PATH__codex\t/home/user/.local/bin/codex\n',
      stderr: '',
      timedOut: false
    })

    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])

    expect(found).toEqual(new Set(['claude', 'codex']))
  })

  it('ignores commands whose resolved path is not absolute', async () => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout: '__ORCA_AGENT_PATH__claude\tclaude\n' + '__ORCA_AGENT_PATH__codex\tC:\\spoof\n',
      stderr: '',
      timedOut: false
    })

    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])

    expect(found).toEqual(new Set())
  })

  it('finds a real command even with rc/motd-shaped noise ahead of it in stdout (regression)', async () => {
    // Before this migration the site ran an uncaptured login shell
    // (buildWslLoginShellCommand) and parsed raw stdout, so the distro's
    // "run a command as administrator" rc/motd banner shared the stream with
    // the payload (#11327, #11823 class). The probe lane runs no shell at all,
    // so a banner has no way to appear; this proves the payload line still
    // parses correctly even when banner-shaped text precedes it.
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout:
        'Welcome to Ubuntu! Run a command as administrator (user "root")...\n' +
        '__ORCA_AGENT_PATH__claude\t/home/user/.nvm/versions/node/v20/bin/claude\n',
      stderr: '',
      timedOut: false
    })

    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])

    expect(found).toEqual(new Set(['claude']))
  })

  it('returns an empty set when wsl.exe cannot be started', async () => {
    runWslProcessMock.mockRejectedValue(new Error('spawn wsl.exe ENOENT'))

    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])

    expect(found).toEqual(new Set())
  })

  it('skips the probe entirely when no commands are requested', async () => {
    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, [])

    expect(found).toEqual(new Set())
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })
})
