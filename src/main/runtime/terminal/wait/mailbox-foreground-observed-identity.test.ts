import { expect, it } from 'vitest'
import { readMailboxForeground } from './mailbox-foreground-read'

const observedCodex = (identity: { foregroundPgid: number; agentPid?: number }) => ({
  getForegroundProcess: async () => 'codex',
  supportsForegroundObservation: () => true,
  inspectProcess: async () => ({
    foregroundProcess: 'codex',
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
      processName: 'codex',
      ...identity
    }
  })
})

it.skipIf(process.platform === 'win32').each([
  // A wrapper leads the job; the agent is its child.
  [
    'the agent itself, not the wrapper leading its job',
    { foregroundPgid: process.ppid, agentPid: process.pid },
    process.pid
  ],
  // An older daemon sends no agentPid.
  [
    'its job leader when the daemon does not name the agent',
    { foregroundPgid: process.ppid },
    process.ppid
  ]
])('names an observed foreground agent by %s', async (_case, identity, pid) => {
  const result = await readMailboxForeground(
    observedCodex(identity),
    { remote: false, windows: false },
    'pty-1',
    'codex',
    'incarnation-1'
  )
  expect(result).toMatchObject({
    foreground: 'agent',
    agent: 'codex',
    process: { pid, startedAtMs: expect.any(Number) }
  })
})
