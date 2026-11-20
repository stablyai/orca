import { expect, it } from 'vitest'
import { readMailboxForeground } from './launched-agent-foreground'

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

it.skipIf(process.platform === 'win32')(
  'names an observed foreground agent by the agent itself, not the wrapper leading its job',
  async () => {
    const result = await readMailboxForeground(
      observedCodex({ foregroundPgid: process.ppid, agentPid: process.pid }),
      { remote: false, windows: false },
      'pty-1',
      'codex',
      'incarnation-1'
    )
    expect(result).toMatchObject({
      foreground: 'agent',
      agent: 'codex',
      process: { pid: process.pid, startedAtMs: expect.any(Number) }
    })
  }
)

// A wrapper (`bash -c 'claude; exec bash -i'`) outlives its agent, so it must not fence out the next one.
it('records no identity when the daemon does not name the agent', async () => {
  const result = await readMailboxForeground(
    observedCodex({ foregroundPgid: process.ppid }),
    { remote: false, windows: false },
    'pty-1',
    'codex',
    'incarnation-1'
  )
  expect(result).toEqual({ foreground: 'agent', agent: 'codex' })
})
