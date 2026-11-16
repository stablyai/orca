import { expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../../shared/process-observation/tables/process-table-snapshot'

const { snapshot } = vi.hoisted(() => ({ snapshot: vi.fn<() => Promise<ProcessTableRow[]>>() }))
vi.mock(
  '../../../shared/process-observation/tables/process-table-snapshot-reader',
  async (load) => ({
    ...(await load<object>()),
    getFreshShellForegroundSnapshot: snapshot
  })
)

const { confirmShellForegroundProcess } = await import('./agent-process')

const SHELL: ProcessTableRow = { pid: 100, ppid: 1, stat: 'Ss+', command: '/bin/zsh' }

it.skipIf(process.platform === 'win32').each([
  ['shell alone', [], false, true],
  ['stopped agent (Ctrl-Z)', [{ pid: 101, ppid: 100, stat: 'T', command: 'codex' }], false, false],
  [
    'background agent (Ctrl-Z, then bg), foreground read',
    [{ pid: 101, ppid: 100, stat: 'S', command: 'codex' }],
    false,
    true
  ],
  [
    'background agent (Ctrl-Z, then bg), exit proof',
    [{ pid: 101, ppid: 100, stat: 'S', command: 'codex' }],
    true,
    false
  ],
  ['reaped zombie, exit proof', [{ pid: 101, ppid: 100, stat: 'Z', command: 'codex' }], true, true]
] as const)('confirms the shell alone: %s', async (_, children, noLiveDescendants, expected) => {
  snapshot.mockResolvedValue([SHELL, ...children])
  expect(await confirmShellForegroundProcess(100, '/bin/zsh', { noLiveDescendants })).toBe(expected)
})
