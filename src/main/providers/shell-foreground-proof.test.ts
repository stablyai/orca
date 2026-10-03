import { describe, expect, it, vi } from 'vitest'
import type { RemoteForegroundEvidence } from '../../shared/foreground-process-evidence'
import {
  proveDaemonShellForeground,
  shellForegroundProofFromInspection
} from './shell-foreground-proof'

// How a daemon or relay answer becomes a proof the command-end verifier acts on: `shell` and
// `unprovable` clear the row, `other` keeps it.

const PTY = 'pty-1'
const INCARNATION = 'pty-1-incarnation'

function observation(overrides: { capturedAgeMs?: number; ptyIncarnationId?: string } = {}) {
  return {
    authorityGeneration: 'host-generation',
    observationEpoch: 1,
    capturedAgeMs: overrides.capturedAgeMs ?? 0,
    ptyId: PTY,
    ptyIncarnationId: overrides.ptyIncarnationId ?? INCARNATION
  }
}

function live(processName: string | null, foregroundPgid: number): RemoteForegroundEvidence {
  return {
    ...observation(),
    verdict: 'live',
    processName,
    fence: {
      platform: 'posix',
      shellPid: 100,
      shellStartTime: 'shell-birth',
      tty: '/dev/pts/3',
      foregroundPgid
    }
  }
}

function proof(evidence: RemoteForegroundEvidence | undefined, notCapturedBefore?: number) {
  const requestStartedAtMonotonic = performance.now()
  return shellForegroundProofFromInspection(
    {
      foregroundProcess: null,
      hasChildProcesses: false,
      ...(evidence ? { foregroundProcessEvidence: evidence } : {})
    },
    {
      ptyId: PTY,
      incarnationId: INCARNATION,
      requestStartedAtMonotonic,
      ...(notCapturedBefore !== undefined ? { notCapturedBefore } : {})
    }
  )
}

describe('fenced foreground evidence as a shell proof', () => {
  it('proves the shell when its own group is in front and no agent is named', () => {
    expect(proof(live(null, 100))).toBe('shell')
  })

  const somethingElseInFront: [string, RemoteForegroundEvidence][] = [
    ['an agent in front', live('codex', 200)],
    ['another command in front', live(null, 200)],
    // Job control off (`set +m`): the agent runs in the shell's own group.
    ['an agent in the shell group', live('claude', 100)],
    [
      'a multiplexer in the pane',
      { ...observation(), verdict: 'unverifiable', reason: 'multiplexer_boundary' }
    ]
  ]
  it.each(somethingElseInFront)('proves something else in front for %s', (_name, evidence) => {
    expect(proof(evidence)).toBe('other')
  })

  const unread: [string, RemoteForegroundEvidence][] = [
    [
      'an unreadable process table',
      { ...observation(), verdict: 'unverifiable', reason: 'process_table_unreadable' }
    ],
    ['evidence for another incarnation', { ...live(null, 100), ptyIncarnationId: 'replacement' }],
    ['evidence past the admission age', { ...live(null, 100), capturedAgeMs: 5_000 }]
  ]
  it.each(unread)('reads no answer from %s', (_name, evidence) => {
    expect(proof(evidence)).toBe('unread')
  })

  it('reads no answer from a shared capture that began before the command end', () => {
    const commandEndedAt = performance.now() - 50
    // Captured 300 ms before the request: the exiting agent was still in front then.
    expect(proof({ ...live('codex', 200), capturedAgeMs: 300 }, commandEndedAt)).toBe('unread')
    expect(proof({ ...live(null, 100), capturedAgeMs: 10 }, commandEndedAt)).toBe('shell')
  })

  const cannotTell: [string, RemoteForegroundEvidence | undefined][] = [
    [
      'a Windows host',
      { ...observation(), verdict: 'unverifiable', reason: 'windows_ssh_foreground_unavailable' }
    ],
    ['a host that predates foreground evidence', undefined]
  ]
  it.each(cannotTell)('cannot tell for %s', (_name, evidence) => {
    expect(proof(evidence)).toBe('unprovable')
  })
})

describe('an inspection the host never answered', () => {
  it('rejects, so the row is kept: loss of contact is never evidence', () => {
    expect(() =>
      shellForegroundProofFromInspection(
        {
          foregroundProcess: null,
          hasChildProcesses: false,
          verdict: 'unverifiable',
          reason: 'transport_loss'
        },
        { ptyId: PTY, incarnationId: INCARNATION, requestStartedAtMonotonic: performance.now() }
      )
    ).toThrow('transport_loss')
  })
})

describe('the terminal daemon shell proof', () => {
  const daemon = (
    platform: NodeJS.Platform,
    confirmed: boolean,
    paneShellInFront = true,
    evidence: RemoteForegroundEvidence = live('codex', 200)
  ) => {
    const confirmPaneShellForeground = vi.fn(async () => paneShellInFront)
    const proof = proveDaemonShellForeground({
      ptyId: PTY,
      incarnationId: INCARNATION,
      platform,
      confirmShellForeground: async () => confirmed,
      inspectProcess: async () => ({
        foregroundProcess: null,
        hasChildProcesses: false,
        foregroundProcessEvidence: evidence
      }),
      confirmPaneShellForeground
    })
    return { proof, confirmPaneShellForeground }
  }

  it("trusts the daemon's own confirm first", async () => {
    await expect(daemon('linux', true, false).proof).resolves.toBe('shell')
  })

  it("then reads this host's own process table under the root the evidence names", async () => {
    // The evidence, possibly from a capture before the exit, still names the agent: the fresh read decides.
    const { proof, confirmPaneShellForeground } = daemon('darwin', false, true)
    await expect(proof).resolves.toBe('shell')
    expect(confirmPaneShellForeground).toHaveBeenCalledWith(100)
    await expect(daemon('darwin', false, false).proof).resolves.toBe('other')
  })

  it('reads no answer from evidence it cannot admit', async () => {
    const stale = { ...live(null, 100), ptyIncarnationId: 'replacement' }
    await expect(daemon('linux', false, true, stale).proof).resolves.toBe('unread')
  })

  it('cannot tell on Windows, where the daemon has no foreground evidence', async () => {
    await expect(daemon('win32', false).proof).resolves.toBe('unprovable')
  })

  it('rejects when the daemon cannot be reached', async () => {
    await expect(
      proveDaemonShellForeground({
        ptyId: PTY,
        incarnationId: INCARNATION,
        platform: 'linux',
        confirmShellForeground: async () => {
          throw new Error('daemon socket closed')
        },
        inspectProcess: async () => ({ foregroundProcess: null, hasChildProcesses: false }),
        confirmPaneShellForeground: async () => true
      })
    ).rejects.toThrow('daemon socket closed')
  })
})
