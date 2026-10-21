import { describe, expect, it } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { judgeTerminalForeground } from './terminal-foreground-group'

type Row = Omit<ProcessTableRow, 'tty' | 'startTime'>

/** A macOS pane under `login`, as `ps -o pid=,ppid=,pgid=,tpgid=,stat=,command= -t` reads it. */
function pane(tpgid: number, jobs: Omit<Row, 'tpgid'>[]): Row[] {
  return [
    {
      pid: 100,
      ppid: 1,
      pgid: 100,
      tpgid,
      stat: 'Ss',
      command: '/usr/bin/login -flpq user /bin/bash --noprofile --norc -p -c'
    },
    { pid: 101, ppid: 100, pgid: 101, tpgid, stat: tpgid === 101 ? 'S+' : 'S', command: '-zsh' },
    ...jobs.map((job) => ({ ...job, tpgid }))
  ]
}

describe('who holds a pane’s terminal, by its foreground process group', () => {
  it.each([
    // The launch line has not run, or the agent it ran exited and handed the terminal back.
    ['the pane’s shell at its prompt', pane(101, []), 'shell'],
    [
      'the agent the launch line ran',
      pane(200, [{ pid: 200, ppid: 101, pgid: 200, stat: 'S+', command: '/opt/bin/claude' }]),
      'agent'
    ],
    // A tcsh or nu launch line, or a wrapper script that does not `exec` its agent.
    [
      'the agent behind the sh that leads its group',
      pane(200, [
        { pid: 200, ppid: 101, pgid: 200, stat: 'S+', command: '/bin/sh /tmp/orca-launch/run.sh' },
        { pid: 201, ppid: 200, pgid: 200, stat: 'S+', command: '/opt/bin/claude' }
      ]),
      'agent'
    ],
    [
      'an agent it cannot recognize behind a bash wrapper',
      pane(200, [
        { pid: 200, ppid: 101, pgid: 200, stat: 'S+', command: 'bash ./start-agent.sh' },
        { pid: 201, ppid: 200, pgid: 200, stat: 'S+', command: 'node /opt/agent/cli.js' }
      ]),
      'agent'
    ],
    // Between its commands a wrapper is only shells, and typing into it could run the text.
    [
      'a bash wrapper alone',
      pane(200, [{ pid: 200, ppid: 101, pgid: 200, stat: 'S+', command: 'bash ./start-agent.sh' }]),
      'shell'
    ],
    [
      'an agent stopped in the background',
      pane(101, [{ pid: 200, ppid: 101, pgid: 200, stat: 'T', command: '/opt/bin/claude' }]),
      'shell'
    ]
  ] as const)('%s: %s', (_label, rows, found) => {
    expect(judgeTerminalForeground(rows, 100, 'claude')).toBe(found)
  })

  it.each([
    ['the root is not on the terminal', pane(101, []).slice(1)],
    ['the terminal has no foreground group', pane(0, [])],
    ['no process is in the foreground group', pane(300, [])]
  ])('proves nothing when %s', (_label, rows) => {
    expect(judgeTerminalForeground(rows, 100, 'claude')).toBe('unknown')
  })
})
