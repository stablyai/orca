import { describe, expect, it, vi } from 'vitest'
import { installTuiAgentClis } from './tui-agent-cli-install-service'

describe('installTuiAgentClis', () => {
  it('reports already_present without running install', async () => {
    const runInstallCommand = vi.fn()
    const result = await installTuiAgentClis(['codex'], {
      platform: 'linux',
      hydrateShellPath: async () => {},
      isCommandOnPath: async () => true,
      runInstallCommand
    })
    expect(result.results).toEqual([{ agent: 'codex', status: 'already_present' }])
    expect(runInstallCommand).not.toHaveBeenCalled()
  })

  it('runs the allowlisted command and verifies PATH after install', async () => {
    let present = false
    const runInstallCommand = vi.fn(async () => {
      present = true
      return { stdout: 'ok', stderr: '' }
    })
    const result = await installTuiAgentClis(['claude'], {
      platform: 'linux',
      hydrateShellPath: async () => {},
      isCommandOnPath: async () => present,
      runInstallCommand
    })
    expect(runInstallCommand).toHaveBeenCalledWith(
      'curl -fsSL https://claude.ai/install.sh | bash',
      'linux'
    )
    expect(result.results).toEqual([{ agent: 'claude', status: 'installed' }])
  })

  it('marks unsupported platform installers', async () => {
    const result = await installTuiAgentClis(['grok'], {
      platform: 'win32',
      hydrateShellPath: async () => {},
      isCommandOnPath: async () => false,
      runInstallCommand: vi.fn()
    })
    expect(result.results).toEqual([
      {
        agent: 'grok',
        status: 'unsupported',
        message: expect.stringContaining('No unattended installer')
      }
    ])
  })

  it('captures install failures without aborting later agents', async () => {
    const runInstallCommand = vi.fn(async (command: string) => {
      if (command.includes('codex')) {
        throw new Error('npm ERR! network')
      }
      return { stdout: 'ok', stderr: '' }
    })
    let present = false
    const result = await installTuiAgentClis(['codex', 'gemini'], {
      platform: 'linux',
      hydrateShellPath: async () => {},
      isCommandOnPath: async (command) => {
        if (command === 'gemini') {
          return present
        }
        return false
      },
      runInstallCommand: async (command) => {
        const output = await runInstallCommand(command)
        if (command.includes('gemini')) {
          present = true
        }
        return output
      }
    })
    expect(result.results).toEqual([
      {
        agent: 'codex',
        status: 'failed',
        message: expect.stringContaining('npm ERR! network')
      },
      { agent: 'gemini', status: 'installed' }
    ])
  })
})
