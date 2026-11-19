import { expect, it } from 'vitest'
import { readMailboxForeground } from './launched-agent-foreground'

const observing = (processName: string | null, stoppedAgent?: string) => ({
  getForegroundProcess: async () => processName,
  confirmForegroundProcess: async () => processName,
  supportsForegroundObservation: () => true,
  inspectProcess: async () => ({
    foregroundProcess: processName,
    hasChildProcesses: true,
    foregroundObservation: {
      ptyId: 'pty-1',
      ptyIncarnationId: 'incarnation-1',
      authorityGeneration: 'test',
      observationEpoch: 1,
      capturedAgeMs: 0,
      verdict: 'observed' as const,
      source: 'pty-master' as const,
      foregroundKind: 'non-shell' as const,
      processName,
      ...(stoppedAgent ? { stoppedAgent, stoppedAgentPid: 500 } : {})
    }
  })
})

const read = (processName: string | null, stoppedAgent?: string) =>
  readMailboxForeground(
    observing(processName, stoppedAgent),
    { remote: false, windows: false },
    'pty-1',
    'claude',
    'incarnation-1'
  )

it('another program in front stands in for the agent only while that agent is stopped on this terminal', async () => {
  await expect(read('cat', 'claude')).resolves.toMatchObject({ foreground: 'non-shell' })
  await expect(read('/usr/bin/ssh', 'claude')).resolves.toMatchObject({ foreground: 'non-shell' })
  await expect(read(null, 'claude')).resolves.toMatchObject({ foreground: 'non-shell' })
})

it('with no stopped agent here, a program in front may be relaying to the agent and proves nothing', async () => {
  await expect(read('cat')).resolves.toMatchObject({ foreground: 'unknown' })
  await expect(read('tmux: client')).resolves.toMatchObject({ foreground: 'unknown' })
  await expect(read('sudo')).resolves.toMatchObject({ foreground: 'unknown' })
  await expect(read('cat', 'codex')).resolves.toMatchObject({ foreground: 'unknown' })
})
