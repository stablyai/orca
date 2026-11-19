import { expect, it } from 'vitest'
import { readMailboxForeground } from './launched-agent-foreground'

it.skipIf(process.platform === 'win32')(
  "names an observed foreground agent by its job leader's process and start time",
  async () => {
    const controller = {
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
          foregroundPgid: process.pid
        }
      })
    }
    const result = await readMailboxForeground(
      controller,
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
