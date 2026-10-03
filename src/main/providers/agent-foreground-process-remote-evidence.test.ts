import { describe, expect, it } from 'vitest'
import { resolveRemoteForegroundEvidence } from './agent-foreground-process-batch'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

function rowsFor(commands: string[], options: { tty?: string; candidateStart?: string } = {}) {
  const tty = options.tty ?? '/dev/pts/2'
  const root = 100
  const pgid = 101
  return [
    {
      pid: root,
      ppid: 1,
      pgid: root,
      tpgid: pgid,
      tty,
      startTime: 'root-start',
      stat: 'Ss',
      command: '/bin/zsh'
    },
    ...commands.map((command, index) => ({
      pid: pgid + index,
      ppid: index === 0 ? root : pgid + index - 1,
      pgid,
      tpgid: pgid,
      tty,
      startTime: options.candidateStart ?? `candidate-${index}`,
      stat: 'S+',
      command
    }))
  ] satisfies ProcessTableRow[]
}

const metadata = {
  ptyId: 'pty-1',
  ptyIncarnationId: 'inc-1',
  authorityGeneration: 'host-a',
  observationEpoch: 1,
  capturedAgeMs: 0,
  platform: 'linux' as const
}

describe('host-stamped remote foreground resolver', () => {
  it('returns live only with POSIX anchor, tty, group, and candidate start fences', () => {
    const evidence = resolveRemoteForegroundEvidence(
      { rootPid: 100, fallbackProcess: 'zsh' },
      metadata,
      rowsFor(['node /opt/codex'])
    )
    expect(evidence).toMatchObject({
      verdict: 'live',
      processName: 'codex',
      ptyId: 'pty-1',
      ptyIncarnationId: 'inc-1',
      fence: {
        platform: 'posix',
        shellPid: 100,
        shellStartTime: 'root-start',
        tty: '/dev/pts/2',
        foregroundPgid: 101,
        process: { pid: 101, startTime: 'candidate-0' }
      }
    })
  })

  it.each([
    ['multiplexer_boundary', rowsFor(['tmux new-session'])],
    ['ambiguous_foreground_group', rowsFor(['node /opt/codex', 'node /opt/claude'])],
    ['candidate_start_time_missing', rowsFor(['node /opt/codex'], { candidateStart: '' })]
  ])('degrades to unverifiable for %s', (reason, rows) => {
    const evidence = resolveRemoteForegroundEvidence(
      { rootPid: 100, fallbackProcess: 'zsh' },
      metadata,
      rows
    )
    expect(evidence).toMatchObject({ verdict: 'unverifiable', reason })
  })

  // macOS `ps -o tty=` prints `??` for "no controlling terminal" where Linux prints
  // `?`, so a detached child read as `??` looked like a child on another terminal.
  describe('on a darwin process table', () => {
    const darwinMetadata = { ...metadata, platform: 'darwin' as const }
    const detached = (tty: string): ProcessTableRow[] => [
      {
        pid: 300,
        ppid: 101,
        pgid: 300,
        tpgid: 300,
        tty,
        startTime: 'detached-start',
        stat: 'S',
        command: '/bin/zsh -c sleep 60'
      }
    ]

    it.each(['??', '?', '-'])(
      'keeps a child with no controlling terminal (%s) inside this pty',
      (tty) => {
        const evidence = resolveRemoteForegroundEvidence(
          { rootPid: 100, fallbackProcess: 'zsh' },
          darwinMetadata,
          [...rowsFor(['node /opt/claude'], { tty: 'ttys003' }), ...detached(tty)]
        )
        expect(evidence).toMatchObject({ verdict: 'live', processName: 'claude' })
      }
    )

    it('still stops at a child that owns a different terminal', () => {
      const evidence = resolveRemoteForegroundEvidence(
        { rootPid: 100, fallbackProcess: 'zsh' },
        darwinMetadata,
        [...rowsFor(['node /opt/claude'], { tty: 'ttys003' }), ...detached('ttys004')]
      )
      expect(evidence).toMatchObject({ verdict: 'unverifiable', reason: 'tty_boundary' })
    })

    it('cannot fence anything from a root with no controlling terminal', () => {
      const evidence = resolveRemoteForegroundEvidence(
        { rootPid: 100, fallbackProcess: 'zsh' },
        darwinMetadata,
        rowsFor(['node /opt/claude'], { tty: '??' })
      )
      expect(evidence).toMatchObject({ verdict: 'unverifiable', reason: 'fence_incomplete' })
    })

    it('names no foreground for a root whose own terminal is absent', () => {
      // The root's `tty` is what the fence is stamped with, so a `??` root has to
      // stop the read rather than fall through and name a detached descendant.
      const detached: ProcessTableRow[] = [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          tpgid: 101,
          tty: '??',
          startTime: 'root-start',
          stat: 'Ss',
          command: '/bin/zsh'
        },
        {
          pid: 400,
          ppid: 100,
          pgid: 400,
          tpgid: 400,
          tty: '??',
          startTime: 'detached-start',
          stat: 'S',
          command: 'node /opt/claude'
        }
      ]
      const evidence = resolveRemoteForegroundEvidence(
        { rootPid: 100, fallbackProcess: 'zsh' },
        darwinMetadata,
        detached
      )
      expect(evidence).toMatchObject({ verdict: 'unverifiable', reason: 'fence_incomplete' })
    })

    it('treats a foreground child that lost its terminal as incomplete evidence', () => {
      const rows = rowsFor(['node /opt/claude'], { tty: 'ttys003' }).map((row) =>
        row.pid === 101 ? { ...row, tty: '??' as const } : row
      )
      const evidence = resolveRemoteForegroundEvidence(
        { rootPid: 100, fallbackProcess: 'zsh' },
        darwinMetadata,
        rows
      )
      expect(evidence).toMatchObject({ verdict: 'unverifiable', reason: 'fence_incomplete' })
    })
  })

  it('always degrades SSH-to-Windows without a job/console foreground primitive', () => {
    expect(
      resolveRemoteForegroundEvidence(
        { rootPid: 100, fallbackProcess: 'powershell.exe' },
        { ...metadata, platform: 'win32' },
        rowsFor(['node /opt/codex'])
      )
    ).toMatchObject({ verdict: 'unverifiable', reason: 'windows_ssh_foreground_unavailable' })
  })
})
