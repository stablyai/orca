import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimeVisibleTerminalState } from './runtime-terminal-state-records'
import {
  AntigravityScreenPermissionPublisher,
  antigravityHookRowMatchesPty
} from './antigravity-screen-permission-publisher'

const baseline: AgentStatusIpcPayload = {
  paneKey: 'pane',
  terminalHandle: 'term-1',
  connectionId: null,
  agentType: 'antigravity',
  state: 'working',
  prompt: 'print marker',
  receivedAt: 1,
  stateStartedAt: 1
}
let approval: RuntimeVisibleTerminalState

beforeAll(async () => {
  const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  try {
    const raw = readFileSync(
      join(__dirname, '__fixtures__/antigravity-windows-command-approval.txt'),
      'utf8'
    )
    await new Promise<void>((resolve) => terminal.write(raw, resolve))
    const buffer = terminal.buffer.active
    approval = {
      lines: Array.from(
        { length: 40 },
        (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
      ),
      generation: 1,
      sequence: 1,
      isAlternateScreen: true
    }
  } finally {
    terminal.dispose()
  }
})

describe('Antigravity screen publication scheduling', () => {
  it('coalesces output during a read and retries the newest frame', async () => {
    const frame = Promise.withResolvers<RuntimeVisibleTerminalState | null>()
    const readScreen = vi.fn().mockReturnValueOnce(frame.promise).mockResolvedValue(approval)
    const publish = vi.fn(() => true)
    const publisher = new AntigravityScreenPermissionPublisher({
      baseline: () => baseline,
      readScreen,
      isCurrent: () => true,
      publish
    })
    publisher.schedule('pty')
    for (let index = 0; index < 100; index += 1) {
      publisher.schedule('pty')
    }
    expect(readScreen).toHaveBeenCalledTimes(1)
    frame.resolve(null)
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1))
    expect(readScreen).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledWith({ baseline, command: 'echo "ORCA_PERMISSION_CAPTURE_OK"' })
  })

  it('does not publish a frame rejected by generation, sequence or liveness validation', async () => {
    const isCurrent = vi.fn(() => false)
    const publish = vi.fn(() => true)
    const publisher = new AntigravityScreenPermissionPublisher({
      baseline: () => baseline,
      readScreen: async () => approval,
      isCurrent,
      publish
    })
    publisher.schedule('pty')
    await vi.waitFor(() => expect(isCurrent).toHaveBeenCalled())
    expect(publish).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {
      lines: ['tool output without a recognized composer'],
      generation: 1,
      sequence: 1,
      isAlternateScreen: false
    }
  ])('does not clear permission from a missing or unrecognized screen: %s', async (screen) => {
    const readScreen = vi.fn(async () => screen)
    const publish = vi.fn(() => true)
    const publisher = new AntigravityScreenPermissionPublisher({
      baseline: () => ({ ...baseline, state: 'waiting' }),
      readScreen,
      isCurrent: () => true,
      publish
    })
    publisher.schedule('pty')
    await vi.waitFor(() => expect(readScreen).toHaveBeenCalled())
    expect(publish).not.toHaveBeenCalled()
  })

  it('does not interpret another provider or a direct SSH mirror', async () => {
    const readScreen = vi.fn(async () => approval)
    const publisher = new AntigravityScreenPermissionPublisher({
      baseline: (id) =>
        id === 'ssh'
          ? { ...baseline, connectionId: 'remote' }
          : { ...baseline, agentType: 'claude' },
      readScreen,
      isCurrent: () => true,
      publish: () => true
    })
    publisher.schedule('ssh')
    publisher.schedule('claude')
    await Promise.resolve()
    expect(readScreen).not.toHaveBeenCalled()
  })

  it('reads a WSL relay row, whose pty this host owns', async () => {
    const publish = vi.fn(() => true)
    const publisher = new AntigravityScreenPermissionPublisher({
      baseline: () => ({ ...baseline, connectionId: 'wsl:Ubuntu-26.04' }),
      readScreen: async () => approval,
      isCurrent: () => true,
      publish
    })
    publisher.schedule('wsl')
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1))
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('echo') })
    )
  })

  it('does not lose output queued between a synchronous empty read and its cleanup', async () => {
    const readBaseline = vi.fn().mockReturnValueOnce(null).mockReturnValue(baseline)
    const publish = vi.fn(() => true)
    const publisher = new AntigravityScreenPermissionPublisher({
      baseline: readBaseline,
      readScreen: async () => approval,
      isCurrent: () => true,
      publish
    })
    publisher.schedule('pty')
    publisher.schedule('pty')
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1))
  })
})

describe('antigravityHookRowMatchesPty', () => {
  const wslPty = { isWsl: true, wslDistro: 'Ubuntu-26.04' }
  const nativePty = { isWsl: false, wslDistro: null }

  it.each([
    ['a native hook row', null, nativePty, true],
    ['a WSL relay row on its own distro', 'wsl:Ubuntu-26.04', wslPty, true],
    [
      'a WSL relay row when the pty distro is the default',
      'wsl:Ubuntu-26.04',
      { isWsl: true, wslDistro: null },
      true
    ],
    ['a WSL relay row on another distro', 'wsl:Debian', wslPty, false],
    ['a WSL relay row on a native pty', 'wsl:Ubuntu-26.04', nativePty, false],
    ['an SSH mirror row', 'ssh-connection', wslPty, false]
  ] as const)('%s → %s', (_label, connectionId, pty, expected) => {
    expect(antigravityHookRowMatchesPty(connectionId, pty)).toBe(expected)
  })
})
