import { expect, it, vi } from 'vitest'
import { readDaemonForeground } from './daemon-agent-presence-request'

it('keeps the old foreground response and adds host capture only when requested', async () => {
  const presence = {
    agent: 'codex',
    process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
  } as const
  const host = {
    getForegroundProcess: vi.fn(() => 'codex'),
    captureAgentPresence: vi.fn(async () => presence),
    probeAgentPresence: vi.fn(async () => 'unverifiable' as const)
  }
  expect(await readDaemonForeground(host, { sessionId: 'pty' })).toEqual({
    foregroundProcess: 'codex'
  })
  expect(host.captureAgentPresence).not.toHaveBeenCalled()
  expect(
    await readDaemonForeground(host, { sessionId: 'pty', captureAgentPresence: true })
  ).toEqual({ agentPresence: presence })
  expect(host.getForegroundProcess).toHaveBeenCalledTimes(1)
  expect(
    await readDaemonForeground(host, { sessionId: 'pty', probeAgentPresence: presence.process })
  ).toEqual({ agentPresenceVerdict: 'unverifiable' })
})
