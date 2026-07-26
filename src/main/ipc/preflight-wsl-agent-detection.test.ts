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

  it('uses the shared alias- and function-neutral PATH lookup', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])

    const payload = lastShCommandPayload()
    const lookupScript = buildPosixCommandPathLookupScript({
      kind: 'shell-variable',
      name: 'cmd'
    })
    expect(payload).toContain(escapeWslShCommandForWindows(lookupScript))
    expect(payload).not.toContain('type -P')
  })

  it('parses detected commands from prefixed stdout', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout:
        '__ORCA_AGENT_PATH__claude\t/usr/bin/claude\n' +
        '__ORCA_AGENT_PATH__codex\t/home/user/.local/bin/codex\n',
      stderr: ''
    })

    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])

    expect(found).toEqual(new Set(['claude', 'codex']))
  })

  it('ignores commands whose resolved path is not absolute', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: '__ORCA_AGENT_PATH__claude\tclaude\n' + '__ORCA_AGENT_PATH__codex\tC:\\spoof\n',
      stderr: ''
    })

    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])

    expect(found).toEqual(new Set())
  })

  it('returns an empty set when the probe fails (e.g. shell parse error)', async () => {
    execFileAsyncMock.mockRejectedValue(new Error("zsh:1: parse error near `done'"))

    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])

    expect(found).toEqual(new Set())
  })

  it('skips the probe entirely when no commands are requested', async () => {
    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, [])

    expect(found).toEqual(new Set())
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })
})
