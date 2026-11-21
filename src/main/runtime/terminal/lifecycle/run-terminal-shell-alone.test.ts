import { expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../../../shared/process-observation/tables/process-table-snapshot'

const { snapshot } = vi.hoisted(() => ({ snapshot: vi.fn<() => Promise<ProcessTableRow[]>>() }))
vi.mock(
  '../../../../shared/process-observation/tables/process-table-snapshot-reader',
  async (load) => ({
    ...(await load<object>()),
    getFreshShellForegroundSnapshot: snapshot
  })
)

const { confirmRootShellAloneFromProcessTable, paneAgentProcess } =
  await import('./run-terminal-shell-alone')

const SHELL: ProcessTableRow = { pid: 100, ppid: 1, stat: 'Ss+', command: '/bin/zsh' }
// macOS roots each PTY at login, with the login shell beneath it.
const LOGIN: ProcessTableRow = { pid: 90, ppid: 1, stat: 'Ss', command: '/usr/bin/login -flp me' }
const LOGIN_SHELL: ProcessTableRow = { pid: 100, ppid: 90, stat: 'S+', command: '-zsh' }

it.skipIf(process.platform === 'win32').each([
  ['a shell root, alone', 100, [SHELL], true],
  ['a login root, its shell alone', 90, [LOGIN, LOGIN_SHELL], true],
  [
    'a login root, an agent stopped (Ctrl-Z)',
    90,
    [LOGIN, LOGIN_SHELL, { pid: 101, ppid: 100, stat: 'T', command: 'codex' }],
    false
  ],
  [
    'a login root, an agent in the foreground',
    90,
    [LOGIN, { ...LOGIN_SHELL, stat: 'S' }, { pid: 101, ppid: 100, stat: 'S+', command: 'codex' }],
    false
  ],
  [
    'a login root, the agent running in the background',
    90,
    [LOGIN, LOGIN_SHELL, { pid: 101, ppid: 100, stat: 'S', command: 'codex exec task' }],
    false
  ],
  [
    'a login root, a stopped process whose argv was unreadable',
    90,
    [LOGIN, LOGIN_SHELL, { pid: 101, ppid: 100, stat: 'T', command: '(codex)' }],
    false
  ],
  [
    'a login root, a stopped sudo whose argv was unreadable',
    90,
    [LOGIN, LOGIN_SHELL, { pid: 101, ppid: 100, stat: 'T', command: '(sudo)' }],
    true
  ],
  [
    'a login root, an exited agent not yet reaped',
    90,
    [LOGIN, LOGIN_SHELL, { pid: 101, ppid: 100, stat: 'Z', command: '(codex)' }],
    true
  ],
  ['no shell under the root', 90, [LOGIN], false],
  [
    'a login root, an editor stopped before the agent ran',
    90,
    [LOGIN, LOGIN_SHELL, { pid: 102, ppid: 100, stat: 'T', command: 'vim notes.md' }],
    true
  ],
  [
    'a login root, another agent suspended before this one ran',
    90,
    [LOGIN, LOGIN_SHELL, { pid: 103, ppid: 100, stat: 'T', command: 'claude' }],
    true
  ]
] as const)('confirms the shell alone from %s', async (_, rootPid, rows, expected) => {
  snapshot.mockResolvedValue([...rows])
  expect(
    await confirmRootShellAloneFromProcessTable(rootPid, {
      paneAgent: paneAgentProcess('codex')
    })
  ).toBe(expected)
})
