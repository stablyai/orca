import { describe, expect, it, vi } from 'vitest'
import {
  parseCodexDoctorChecks,
  probeAgentHealth,
  probeAgentProviderHealth,
  updateAgent
} from './agent-health-probe'

describe('agent health probe', () => {
  it('keeps only connection-related Codex doctor checks', () => {
    const checks = parseCodexDoctorChecks(
      JSON.stringify({
        checks: [
          { id: 'auth.credentials', status: 'ok' },
          { id: 'network.provider_reachability', status: 'warning' },
          { id: 'network.websocket_reachability', status: 'fail' },
          { id: 'terminal.env', status: 'fail' },
          { id: 'mcp.config', status: 'warning' }
        ]
      })
    )

    expect(checks).toEqual([
      { id: 'authentication', status: 'ok' },
      { id: 'provider', status: 'warning' },
      { id: 'websocket', status: 'failed' }
    ])
  })

  it('automatically reads update availability for both CLIs', async () => {
    const runCommand = vi.fn(async (provider: 'claude' | 'codex', args: string[]) => {
      if (args[0] === '--version') {
        return {
          stdout: provider === 'claude' ? '1.0.61 (Claude Code)' : 'codex-cli 0.146.1',
          stderr: ''
        }
      }
      if (args[0] === 'update') {
        return { stdout: 'Update Codex or Claude Code', stderr: '' }
      }
      if (args[0] === 'config') {
        return { stdout: 'stable\n', stderr: '' }
      }
      const error = Object.assign(new Error('doctor reported a failed check'), {
        stdout: JSON.stringify({
          checks: {
            'auth.credentials': { status: 'ok' },
            'network.provider_reachability': { status: 'ok' },
            'network.websocket_reachability': { status: 'ok' },
            'terminal.env': { status: 'fail' },
            'updates.status': {
              status: 'warning',
              details: { 'latest version': '0.147.0' }
            }
          }
        })
      })
      throw error
    })
    const resolveClaudeVersion = vi.fn(async () => '1.0.62')

    const snapshots = await probeAgentHealth(undefined, { runCommand, resolveClaudeVersion })

    expect(runCommand).toHaveBeenCalledTimes(6)
    expect(resolveClaudeVersion).toHaveBeenCalledWith('stable')
    expect(
      runCommand.mock.calls.some(
        ([provider, args]) => provider === 'claude' && args[0] === 'doctor'
      )
    ).toBe(false)
    expect(snapshots).toMatchObject([
      {
        provider: 'claude',
        cliStatus: 'available',
        health: 'healthy',
        version: '1.0.61',
        checks: [{ id: 'cli', status: 'ok' }],
        latestVersion: '1.0.62',
        updateAvailability: 'available',
        updateSupported: true
      },
      {
        provider: 'codex',
        cliStatus: 'available',
        health: 'healthy',
        version: '0.146.1',
        checks: [
          { id: 'cli', status: 'ok' },
          { id: 'authentication', status: 'ok' },
          { id: 'provider', status: 'ok' },
          { id: 'websocket', status: 'ok' }
        ],
        latestVersion: '0.147.0',
        updateAvailability: 'available',
        updateSupported: true
      }
    ])
  })

  it('reports unknown Codex health when doctor output is unavailable', async () => {
    const runCommand = vi.fn(async (_provider: 'claude' | 'codex', args: string[]) => {
      if (args[0] === '--version') {
        return { stdout: 'codex-cli 0.146.1', stderr: '' }
      }
      if (args[0] === 'doctor') {
        throw new Error('doctor unavailable')
      }
      return { stdout: 'Update Codex', stderr: '' }
    })

    await expect(
      probeAgentProviderHealth('codex', undefined, { runCommand })
    ).resolves.toMatchObject({
      provider: 'codex',
      cliStatus: 'available',
      health: 'unknown',
      version: '0.146.1',
      checks: [{ id: 'cli', status: 'ok' }]
    })
  })

  it('reports an unavailable CLI without attempting its deeper checks', async () => {
    const runCommand = vi.fn(async (provider: 'claude' | 'codex', _args: string[]) => {
      if (provider === 'codex') {
        throw new Error('not found')
      }
      return { stdout: '1.0.61 (Claude Code)', stderr: '' }
    })
    const resolveClaudeVersion = vi.fn(async () => '1.0.61')

    const snapshots = await probeAgentHealth(undefined, {
      runCommand,
      resolveClaudeVersion
    })
    const claude = snapshots.find((snapshot) => snapshot.provider === 'claude')
    const codex = snapshots.find((snapshot) => snapshot.provider === 'codex')

    expect(resolveClaudeVersion).toHaveBeenCalledWith('latest')
    expect(claude).toMatchObject({ updateAvailability: 'current' })
    expect(codex).toMatchObject({
      cliStatus: 'unavailable',
      health: 'unhealthy',
      version: null,
      checks: [{ id: 'cli', status: 'failed' }]
    })
    expect(
      runCommand.mock.calls.some(([provider, args]) => provider === 'codex' && args[0] === 'doctor')
    ).toBe(false)
  })

  it('probes only the selected provider', async () => {
    const runCommand = vi.fn(async (_provider: 'claude' | 'codex', args: string[]) => {
      if (args[0] === '--version') {
        return { stdout: 'codex-cli 0.146.1', stderr: '' }
      }
      if (args[0] === 'doctor') {
        return { stdout: JSON.stringify({ checks: [] }), stderr: '' }
      }
      return { stdout: 'Update Codex', stderr: '' }
    })

    await expect(
      probeAgentProviderHealth('codex', undefined, { runCommand })
    ).resolves.toMatchObject({ provider: 'codex', version: '0.146.1' })
    expect(runCommand.mock.calls.every(([provider]) => provider === 'codex')).toBe(true)
  })

  it('runs the provider updater and reports the installed version change', async () => {
    let versionCallCount = 0
    const runCommand = vi.fn(async (_provider: 'claude' | 'codex', args: string[]) => {
      if (args[0] === '--version') {
        versionCallCount += 1
        return {
          stdout: versionCallCount === 1 ? 'codex-cli 0.146.1' : 'codex-cli 0.147.0',
          stderr: ''
        }
      }
      return { stdout: 'Updated successfully', stderr: '' }
    })

    await expect(updateAgent('codex', undefined, { runCommand })).resolves.toEqual({
      provider: 'codex',
      outcome: 'updated',
      previousVersion: '0.146.1',
      currentVersion: '0.147.0'
    })
    expect(runCommand.mock.calls.map(([, args]) => args)).toEqual([
      ['--version'],
      ['update'],
      ['--version']
    ])
  })
})
