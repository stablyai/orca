import { expect, it } from 'vitest'
import { readMailboxForeground } from './launched-agent-foreground'

const observing = (processName: string | null) => ({
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
      processName
    }
  })
})

const read = (processName: string | null) =>
  readMailboxForeground(
    observing(processName),
    { remote: false, windows: false },
    'pty-1',
    'claude',
    'incarnation-1'
  )

it('another program in front is told apart from a multiplexer relaying to the agent', async () => {
  await expect(read('cat')).resolves.toMatchObject({ foreground: 'non-shell' })
  await expect(read('tmux')).resolves.toMatchObject({ foreground: 'unknown' })
  await expect(read('/usr/bin/ssh')).resolves.toMatchObject({ foreground: 'unknown' })
})

it('a foreground whose name cannot be read proves nothing', async () => {
  await expect(read(null)).resolves.toMatchObject({ foreground: 'unknown' })
})
