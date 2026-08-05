import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  detectLocal: vi.fn(),
  detectRemote: vi.fn()
}))

vi.mock('../ipc/tui-agent-inventory-detection', () => ({
  detectInstalledAgentCommandsWithShellPathHydration: mocks.detectLocal,
  detectRemoteAgentCommands: mocks.detectRemote
}))

import {
  resetRuntimeCursorCommandCacheForTests,
  resolveRuntimeAgentCommandOverrides
} from './runtime-cursor-command'

const inventory = (command?: string) => ({
  version: 1 as const,
  agents: command ? (['cursor'] as const) : [],
  matchedCommands: command ? { cursor: command } : {}
})

beforeEach(() => {
  resetRuntimeCursorCommandCacheForTests()
  mocks.detectLocal.mockReset().mockResolvedValue(inventory())
  mocks.detectRemote.mockReset().mockResolvedValue(inventory())
})

describe('resolveRuntimeAgentCommandOverrides', () => {
  it('keeps an explicit override authoritative without probing', async () => {
    await expect(
      resolveRuntimeAgentCommandOverrides({
        agent: 'cursor',
        cmdOverrides: { cursor: 'cursor-dev' },
        workspacePath: '/repo'
      })
    ).resolves.toEqual({ cursor: 'cursor-dev' })
    expect(mocks.detectLocal).not.toHaveBeenCalled()
  })

  it('uses the native or exact WSL inventory match', async () => {
    mocks.detectLocal.mockResolvedValueOnce(inventory('cursor agent'))
    await expect(
      resolveRuntimeAgentCommandOverrides({
        agent: 'cursor',
        cmdOverrides: {},
        workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo'
      })
    ).resolves.toEqual({ cursor: 'cursor agent' })
    expect(mocks.detectLocal).toHaveBeenCalledWith({ wslDistro: 'Ubuntu' })
  })

  it('prefers configured WSL for an ordinary Windows workspace path', async () => {
    mocks.detectLocal.mockResolvedValueOnce(inventory('cursor-agent'))
    await expect(
      resolveRuntimeAgentCommandOverrides({
        agent: 'cursor',
        cmdOverrides: {},
        wslDistro: ' Ubuntu ',
        workspacePath: 'C:\\src\\repo'
      })
    ).resolves.toEqual({ cursor: 'cursor-agent' })
    expect(mocks.detectLocal).toHaveBeenCalledWith({ wslDistro: 'Ubuntu' })
  })

  it('uses only the selected SSH connection inventory', async () => {
    mocks.detectRemote.mockResolvedValueOnce(inventory('cursor-agent'))
    await expect(
      resolveRuntimeAgentCommandOverrides({
        agent: 'cursor',
        cmdOverrides: {},
        connectionId: 'ssh-1',
        workspacePath: '/repo'
      })
    ).resolves.toEqual({ cursor: 'cursor-agent' })
    expect(mocks.detectRemote).toHaveBeenCalledWith({ connectionId: 'ssh-1' })
    expect(mocks.detectLocal).not.toHaveBeenCalled()
  })

  it('leaves Cursor unavailable when probing fails or has no capability match', async () => {
    mocks.detectLocal.mockRejectedValueOnce(new Error('unavailable'))
    await expect(
      resolveRuntimeAgentCommandOverrides({
        agent: 'cursor',
        cmdOverrides: {},
        workspacePath: '/repo'
      })
    ).resolves.toEqual({})
  })

  it('probes once per host and keeps separate hosts isolated', async () => {
    mocks.detectLocal.mockResolvedValue(inventory('cursor-agent'))
    mocks.detectRemote.mockResolvedValue(inventory('cursor agent'))
    const local = { agent: 'cursor' as const, cmdOverrides: {}, workspacePath: '/repo' }
    await expect(
      Promise.all([
        resolveRuntimeAgentCommandOverrides(local),
        resolveRuntimeAgentCommandOverrides(local),
        resolveRuntimeAgentCommandOverrides({ ...local, connectionId: 'ssh-1' })
      ])
    ).resolves.toEqual([
      { cursor: 'cursor-agent' },
      { cursor: 'cursor-agent' },
      { cursor: 'cursor agent' }
    ])
    await expect(resolveRuntimeAgentCommandOverrides(local)).resolves.toEqual({
      cursor: 'cursor-agent'
    })
    expect(mocks.detectLocal).toHaveBeenCalledTimes(1)
    expect(mocks.detectRemote).toHaveBeenCalledTimes(1)
  })

  it('does not probe commands for other agents', async () => {
    const overrides = { claude: 'claude-dev' }
    await expect(
      resolveRuntimeAgentCommandOverrides({
        agent: 'claude',
        cmdOverrides: overrides,
        workspacePath: '/repo'
      })
    ).resolves.toBe(overrides)
    expect(mocks.detectLocal).not.toHaveBeenCalled()
  })
})
