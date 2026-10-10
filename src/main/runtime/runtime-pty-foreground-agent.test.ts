import { describe, expect, it, vi } from 'vitest'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

function setup(process: string, commandLine: string | null) {
  const pty = { connected: true, launchAgent: null, foregroundAgent: null }
  const controller = { getForegroundProcess: async () => process }
  const readForegroundCommandLine = vi.fn(async () => commandLine)
  const agent = new RuntimePtyForegroundAgent({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: load reads only getForegroundProcess.
    getController: () => controller as unknown as RuntimePtyController,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: load reads only connected, launchAgent and foregroundAgent.
    getPty: () => pty as unknown as RuntimePtyWorktreeRecord,
    touchSnapshot: () => {},
    finishDelayedSnapshot: () => {},
    readForegroundCommandLine
  })
  return { agent, pty, readForegroundCommandLine }
}

describe('RuntimePtyForegroundAgent', () => {
  it('names an agent hosted by a runtime from its command line', async () => {
    const { agent, pty } = setup('node', 'node /usr/local/lib/node_modules/.bin/dsh-tui . --yolo')

    expect(await agent.refresh('pty-1')).toBe(true)

    expect(pty.foregroundAgent).toBe('dsh')
  })

  it('names an agent by its process without reading the command line', async () => {
    const { agent, pty, readForegroundCommandLine } = setup('codex', null)

    await agent.refresh('pty-1')

    expect(pty.foregroundAgent).toBe('codex')
    expect(readForegroundCommandLine).not.toHaveBeenCalled()
  })

  it.each([
    ['a runtime running something else', 'node', 'node server.js'],
    ['an unreadable command line', 'node', null],
    ['a non-runtime process', 'log-pager', 'log-pager build.log']
  ])('names no agent for %s', async (_case, process, commandLine) => {
    const { agent, pty } = setup(process, commandLine)

    await agent.refresh('pty-1')

    expect(pty.foregroundAgent).toBeNull()
  })
})
