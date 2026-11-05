import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteForegroundEvidence } from '../../../../shared/foreground-process-evidence'
import type { ProcessTableRow } from '../../../../shared/process-table-snapshot'
import type * as TerminalForegroundGroup from '../../../pty/process-retirement/terminal-process-rows'

import { readLaunchedAgentForeground } from './launched-agent-foreground'

const paneTerminal = vi.hoisted(() => {
  const state: { rows: ProcessTableRow[] | null } = { rows: null }
  return state
})
vi.mock('../../../pty/process-retirement/terminal-process-rows', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalForegroundGroup>()),
  readTerminalProcessRows: vi.fn(async () => paneTerminal.rows)
}))

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

describe('the relay’s foreground group as proof of a launched agent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Capture start time matters; a slow ps result can still describe evidence requested by this read.
  it('counts a capture begun after the read was asked for, however long `ps` took', async () => {
    const controller = controllerAnswering(async () => {
      vi.advanceTimersByTime(1_800)
      return claudeInGroup(1_800)
    })

    await expect(
      readLaunchedAgentForeground(controller, POSIX_SSH, 'pty-1', 'claude')
    ).resolves.toBe('agent')
  })

  function unverifiable(reason: string): RemoteForegroundEvidence {
    return {
      verdict: 'unverifiable',
      reason,
      authorityGeneration: 'gen-1',
      observationEpoch: 1,
      capturedAgeMs: 0,
      ptyId: 'pty-1',
      ptyIncarnationId: 'inc-1'
    }
  }

  it('completes structural evidence with a name read now, never the tracker’s display cache', async () => {
    // The tracker cached `codex` at 100ms; Codex exited at 101ms to a bash; the guard runs at 999ms.
    const controller = {
      ...controllerAnswering(async () => ({
        ...unverifiable('ambiguous_foreground_group'),
        capturedAgeMs: 999
      })),
      getForegroundProcess: async () => 'codex',
      confirmForegroundProcess: async () => 'bash'
    }

    await expect(
      readLaunchedAgentForeground(controller, POSIX_SSH, 'pty-1', 'codex')
    ).resolves.toBe('shell')
  })
})

// Guarded pastes must use terminal-local probes instead of slow whole-machine scans.

describe('owner-held recipient observations', () => {
  it('keeps an unresolved owner unknown and never fills a fresh unavailable result with cached identity', async () => {
    const cachedName = vi.fn(async () => 'claude')
    const inventory = vi.fn()
    expect(
      await readLaunchedAgentForeground(
        {
          supportsForegroundObservation: () => true,
          inspectProcess: async () => ({
            foregroundProcess: 'claude',
            hasChildProcesses: true,
            foregroundObservation: {
              ptyId: 'pty-1',
              ptyIncarnationId: 'inc',
              authorityGeneration: 'owner',
              observationEpoch: 1,
              capturedAgeMs: 0,
              verdict: 'unverifiable',
              reason: 'owner_unavailable'
            }
          }),
          getForegroundProcess: cachedName,
          listProcesses: inventory
        },
        { remote: false, windows: false },
        'pty-1',
        'claude'
      )
    ).toBe('unknown')
    expect(cachedName).not.toHaveBeenCalled()
    expect(inventory).not.toHaveBeenCalled()
  })
})
