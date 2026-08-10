import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileAsyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileAsyncMock: vi.fn()
}))

vi.mock('child_process', () => {
  const execFileWithPromisify = Object.assign(execFileMock, {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
  return {
    execFile: execFileWithPromisify,
    spawn: vi.fn()
  }
})

import { detectWslCommandsOnPath } from './preflight-wsl-agent-detection'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
import { escapeWslShCommandForWindows } from '../../shared/wsl-login-shell-command'

function lastShCommandPayload(): string {
  const call = execFileAsyncMock.mock.calls.at(-1)
  expect(call).toBeDefined()
  const [file, args] = call as [string, string[]]
  expect(file).toBe('wsl.exe')
  // args: [...distroArgs, '--', 'sh', '-c', <payload>]
  return args.at(-1) as string
}

describe('detectWslCommandsOnPath', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds a probe script with no `fi done` (zsh parse error) sequence', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])

    const payload = lastShCommandPayload()
    // Why: zsh aborts on `fi done` — the loop body and `done` must be separated
    // by a newline. Regression guard for issue #5325.
    expect(payload).not.toContain('fi done')
    expect(payload).toContain('fi\ndone')
  })

  it('uses the shared alias- and function-neutral PATH lookup, skipping /mnt', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])

    const payload = lastShCommandPayload()
    const lookupScript = buildPosixCommandPathLookupScript(
      { kind: 'shell-variable', name: 'cmd' },
      { skipWindowsMountDirs: true }
    )
    expect(payload).toContain(escapeWslShCommandForWindows(lookupScript))
    // Why: WSL appends the Windows PATH as a slow drvfs /mnt tail; the probe
    // must skip it or the lookup can time out (issue #9725 root cause).
    expect(payload).toContain('/mnt|/mnt/*)')
    expect(payload).not.toContain('type -P')
  })

  it('parses detected commands from prefixed stdout', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout:
        '__ORCA_AGENT_PATH__claude\t/usr/bin/claude\n' +
        '__ORCA_AGENT_PATH__codex\t/home/user/.local/bin/codex\n',
      stderr: ''
    })

    const { found } = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])

    expect(found).toEqual(new Set(['claude', 'codex']))
  })

  it('ignores commands whose resolved path is not absolute', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: '__ORCA_AGENT_PATH__claude\tclaude\n' + '__ORCA_AGENT_PATH__codex\tC:\\spoof\n',
      stderr: ''
    })

    const { found } = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])

    expect(found).toEqual(new Set())
  })

  it('marks a failed probe as failed instead of returning a plain empty set', async () => {
    execFileAsyncMock.mockRejectedValue(new Error("zsh:1: parse error near `done'"))

    const result = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])

    // Why: a timed-out or errored probe must not be indistinguishable from
    // "no agents installed" — callers surface a retry affordance on failure.
    expect(result).toEqual({ found: new Set(), failed: true })
  })

  it('returns a clean empty result (not failed) when nothing is found', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    const result = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])

    expect(result).toEqual({ found: new Set(), failed: false })
  })

  it('skips the probe entirely when no commands are requested', async () => {
    const result = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, [])

    expect(result).toEqual({ found: new Set(), failed: false })
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })
})
