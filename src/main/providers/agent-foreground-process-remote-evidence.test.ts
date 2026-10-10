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

  it.each(['?', '??', '-', '0', '0,0'])(
    'keeps the OpenCode TUI live beside a detached service with tty %s',
    (tty) => {
      const rows = rowsFor(['opencode'], { tty: 'ttys096' })
      rows.push({
        pid: 102,
        ppid: 101,
        pgid: 102,
        tpgid: 0,
        tty,
        startTime: 'service-start',
        stat: 'Ss',
        command: 'opencode serve --hostname 127.0.0.1 --port 59374'
      })
      expect(
        resolveRemoteForegroundEvidence(
          { rootPid: 100, fallbackProcess: 'zsh' },
          { ...metadata, platform: 'darwin' },
          rows
        )
      ).toMatchObject({
        verdict: 'live',
        processName: 'opencode',
        fence: { process: { pid: 101, startTime: 'candidate-0' }, tty: 'ttys096' }
      })
    }
  )

  it.each(['?', '??', '-', '0', '0,0'])(
    'refuses a foreground-group member whose controlling tty is %s',
    (tty) => {
      const rows = rowsFor(['opencode'])
      rows[1].tty = tty
      expect(
        resolveRemoteForegroundEvidence({ rootPid: 100, fallbackProcess: 'zsh' }, metadata, rows)
      ).toMatchObject({ verdict: 'unverifiable', reason: 'fence_incomplete' })
    }
  )

  it.each(['?', '??', '-', '0', '0,0'])('refuses a root without a controlling tty: %s', (tty) => {
    const rows = rowsFor(['opencode'], { tty })
    expect(
      resolveRemoteForegroundEvidence({ rootPid: 100, fallbackProcess: 'zsh' }, metadata, rows)
    ).toMatchObject({ verdict: 'unverifiable', reason: 'fence_incomplete' })
  })

  it('refuses a descendant attached to another real terminal', () => {
    const rows = rowsFor(['opencode', '/bin/bash'])
    rows[2].pgid = 102
    rows[2].tty = '/dev/pts/3'
    expect(
      resolveRemoteForegroundEvidence({ rootPid: 100, fallbackProcess: 'zsh' }, metadata, rows)
    ).toMatchObject({ verdict: 'unverifiable', reason: 'tty_boundary' })
  })

  it('still refuses a detached multiplexer without a session fence', () => {
    const rows = rowsFor(['opencode', 'tmux new-session'])
    rows[2].pgid = 102
    rows[2].tpgid = 0
    rows[2].tty = '??'
    expect(
      resolveRemoteForegroundEvidence({ rootPid: 100, fallbackProcess: 'zsh' }, metadata, rows)
    ).toMatchObject({ verdict: 'unverifiable', reason: 'multiplexer_boundary' })
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
