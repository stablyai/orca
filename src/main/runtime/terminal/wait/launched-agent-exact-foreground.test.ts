import { describe, expect, it } from 'vitest'
import type { RemoteForegroundEvidence } from '../../../../shared/terminal/pty/foreground/foreground-process-evidence'

import { readExactAgentForeground, readLaunchedAgentForeground } from './launched-agent-foreground'

function claudeInGroup(capturedAgeMs: number): RemoteForegroundEvidence {
  return {
    verdict: 'live',
    processName: 'claude',
    fence: {
      platform: 'posix',
      shellPid: 40100,
      shellStartTime: 'Fri Oct  2 09:30:01 2026',
      tty: 'ttys007',
      foregroundPgid: 40210
    },
    authorityGeneration: 'gen-1',
    observationEpoch: 1,
    capturedAgeMs,
    ptyId: 'pty-1',
    ptyIncarnationId: 'inc-1'
  }
}

function controllerAnswering(inspect: () => Promise<RemoteForegroundEvidence>) {
  return {
    getForegroundProcess: async () => 'sh',
    confirmForegroundProcess: async () => 'sh',
    confirmShellForeground: async () => false,
    inspectProcess: async () => ({
      foregroundProcess: 'sh',
      hasChildProcesses: true,
      foregroundProcessEvidence: await inspect()
    })
  }
}

const POSIX_SSH = { remote: true, windows: false }

// A reattach restores the daemon-named agent where nothing can be read, never where another program is seen.
describe('an exact read tells another program in front from an unreadable foreground', () => {
  function ownerSeeing(processName: string, confirmed: string | null) {
    return {
      supportsForegroundObservation: () => true,
      inspectProcess: async () => ({
        foregroundProcess: processName,
        hasChildProcesses: true,
        foregroundObservation: {
          ptyId: 'pty-1',
          ptyIncarnationId: 'inc',
          authorityGeneration: 'owner',
          observationEpoch: 1,
          capturedAgeMs: 0,
          verdict: 'observed' as const,
          source: 'posix-process-table' as const,
          foregroundKind: 'non-shell' as const,
          processName
        }
      }),
      getForegroundProcess: async () => processName,
      confirmForegroundProcess: async () => confirmed,
      confirmShellForeground: async () => false
    }
  }

  it.each([
    ['local vim', { remote: false, windows: false }, ownerSeeing('vim', 'vim'), 'other'],
    [
      'local, no fresh name',
      { remote: false, windows: false },
      ownerSeeing('vim', null),
      'unknown'
    ],
    ['SSH vim', POSIX_SSH, ownerSeeing('vim', 'vim'), 'other'],
    ['Windows', { remote: false, windows: true }, ownerSeeing('vim', 'vim'), 'unknown'],
    [
      'an older SSH relay’s fresh group evidence of vim',
      POSIX_SSH,
      {
        ...controllerAnswering(async () => ({ ...claudeInGroup(0), processName: 'vim' })),
        getForegroundProcess: async () => 'vim'
      },
      'other'
    ],
    [
      'an older SSH relay’s ambiguous group completed by a fresh vim name',
      POSIX_SSH,
      {
        ...controllerAnswering(async () => ({
          verdict: 'unverifiable' as const,
          reason: 'ambiguous_foreground_group',
          authorityGeneration: 'gen-1',
          observationEpoch: 1,
          capturedAgeMs: 0,
          ptyId: 'pty-1',
          ptyIncarnationId: 'inc-1'
        })),
        confirmForegroundProcess: async () => 'vim'
      },
      'other'
    ]
  ] as const)('%s', async (_case, host, controller, expected) => {
    const runtime = {
      readLaunchedAgentForeground: (
        ptyId: string,
        agent: 'claude',
        exact?: { named: boolean; other?: boolean }
      ) => readLaunchedAgentForeground(controller, host, ptyId, agent, undefined, exact)
    }
    await expect(readExactAgentForeground(runtime, controller, 'pty-1', 'claude')).resolves.toBe(
      expected
    )
  })
})
