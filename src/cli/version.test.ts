import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from './index'

const { callMock, dispatchMock } = vi.hoisted(() => ({ callMock: vi.fn(), dispatchMock: vi.fn() }))

vi.mock('./dispatch', () => ({ dispatch: dispatchMock }))
vi.mock('./runtime-client', () => ({
  RuntimeClient: class {
    call = callMock
  }
}))

describe('CLI version', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    dispatchMock.mockReset()
  })

  it.each(['--version', '-v', '-V'])('prints the Orca application version for %s', async (flag) => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string
    }
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main([flag], '/tmp/repo')

    expect(stdout).toHaveBeenCalledWith(`${packageJson.version}\n`)
  })

  it('does not consume version-like arguments from Claude passthrough', async () => {
    await main(['claude-teams', '--version'], '/tmp/repo')

    expect(dispatchMock).toHaveBeenCalledWith(
      ['claude-teams'],
      expect.objectContaining({ rawArgs: ['--version'] })
    )
  })

  it('does not consume the tmux shim version probe', async () => {
    callMock.mockResolvedValue({
      result: { tmux: { stdout: 'tmux 3.4\n', stderr: '', exitCode: 0 } }
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['agent-teams-tmux', '-V'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'agentTeams.tmuxCompat',
      expect.objectContaining({ argv: ['-V'] }),
      { timeoutMs: 10_000 }
    )
    expect(stdout).toHaveBeenCalledWith('tmux 3.4\n')
  })
})
