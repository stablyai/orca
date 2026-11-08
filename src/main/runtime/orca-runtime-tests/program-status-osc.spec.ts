import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { committingSpawn } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import './orca-runtime-test-scenario-builders.spec'
import type { RuntimeTerminalAgentStatusEvent } from '../terminal/output/terminal-agent-status-events'
import {
  TEST_WORKTREE_PATH,
  expectStablePaneKeyEnv,
  store
} from './orca-runtime-test-fixtures.spec'
import { spawnedPtyEnv } from '../spawned-pty-env-fixtures'

describe('OSC 7501 program status', () => {
  it('projects split reports from a rendererless PTY into hook-yielding status events', async () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-ps' })
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'claude', title: 'w' })
    const paneKey = expectStablePaneKeyEnv(spawnedPtyEnv(spawn.mock.calls[0]?.[0]))

    const question = Buffer.from('answer: Tea or coffee?').toString('base64')
    runtime.onPtyData('pty-ps', 'x\x1b]7501;state=working:app=claude-code\x1b\\\x1b]75', 1)
    runtime.onPtyData(
      'pty-ps',
      `01;state=blocked:kind=question:app=claude-code:msg=${question}\x07`,
      2
    )

    expect(
      statuses.map((event) => [event.paneKey, event.fromProgramStatus, event.payload])
    ).toEqual([
      [paneKey, true, expect.objectContaining({ state: 'working', agentType: 'claude' })],
      [
        paneKey,
        true,
        expect.objectContaining({
          state: 'waiting',
          agentType: 'claude',
          toolInput: 'answer: Tea or coffee?'
        })
      ]
    ])
  })

  it('reports a lasting sign-in block as blocked instead of waiting out tui-idle (#37056, #28348)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    vi.setSystemTime(1_000_000)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agy' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'w'
    })
    const signIn = Buffer.from('Sign in required').toString('base64')
    // agy 1.5.2's bytes at its "Select login method" menu.
    runtime.onPtyData(
      'pty-agy',
      `\x1b]7501;state=blocked:kind=auth:app=antigravity:msg=${signIn}\x07Select login method:\r\n> 1. Google OAuth\r\n`,
      Date.now()
    )
    // agy flashes this at startup before signing itself in, so a fresh block is not yet final.
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).rejects.toThrow('timeout')

    vi.setSystemTime(1_003_001)
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({ satisfied: false, blockedReason: 'agent-sign-in-prompt' })

    runtime.onPtyData('pty-agy', '\x1b]7501;state=idle:app=antigravity\x07', Date.now())
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({ satisfied: true })
  })
})
