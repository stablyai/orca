import { describe, expect, it, vi } from 'vitest'
import { resolveAgentForegroundProcessFromPs } from '../providers/agent-foreground-process'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type * as ProcessTableSnapshotReader from '../../shared/process-table-snapshot-reader'
import {
  confirmRootShellHasNoChildrenFromProcessTable,
  inspectionShowsShellAlone
} from './run-terminal-shell-alone'

const strictCapture = vi.hoisted(() => vi.fn<() => Promise<ProcessTableRow[]>>())
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessTableSnapshotReader>()),
  getFreshProcessTableSnapshot: strictCapture
}))

// macOS wraps the login shell in `/usr/bin/login`, so the PTY's root is not the shell.
const LOGIN = {
  pid: 100,
  ppid: 1,
  tty: 'ttys004',
  stat: 'Ss',
  command: '/usr/bin/login -flpq me /bin/zsh'
}
const SHELL = { pid: 101, ppid: 100, tty: 'ttys004', stat: 'S+', command: '-zsh' }

describe('confirmRootShellHasNoChildrenFromProcessTable (the POSIX exit proof)', () => {
  it('proves the shell alone under its login wrapper', async () => {
    strictCapture.mockResolvedValue([LOGIN, SHELL])
    expect(await confirmRootShellHasNoChildrenFromProcessTable(100)).toBe(
      process.platform === 'darwin'
    )
  })

  it('never proves it while an agent runs in the background of the foreground shell', async () => {
    strictCapture.mockResolvedValue([
      LOGIN,
      SHELL,
      { pid: 102, ppid: 101, tty: 'ttys004', stat: 'S', command: 'omp' }
    ])
    expect(await confirmRootShellHasNoChildrenFromProcessTable(100)).toBe(false)
  })

  it('counts agent ancestors and unrecognized wrappers instead of discovering a shell below them', async () => {
    for (const root of ['omp', '/usr/bin/login -flp me omp', 'unknown-wrapper /bin/zsh']) {
      strictCapture.mockResolvedValue([
        { ...LOGIN, command: root },
        { ...SHELL, command: root.includes('login') ? 'omp' : '/bin/zsh' },
        { ...SHELL, pid: 102, ppid: 101, command: '/bin/zsh' }
      ])
      expect(await confirmRootShellHasNoChildrenFromProcessTable(100)).toBe(false)
    }
    strictCapture.mockResolvedValue([{ ...SHELL, pid: 100, ppid: 1 }])
    expect(await confirmRootShellHasNoChildrenFromProcessTable(100)).toBe(true)
    strictCapture.mockResolvedValue([LOGIN, { ...SHELL, command: '/bin/bash' }])
    expect(await confirmRootShellHasNoChildrenFromProcessTable(100)).toBe(false)
  })

  it('recognizes the recorded login-wrapper agent and proves shell-alone only after its exit', async () => {
    // Recorded argv/ancestry; identifiers, paths and TTY/stat are fixture values, and exit is derived.
    const host = {
      ...LOGIN,
      pid: 99,
      tty: '?',
      command:
        '/placeholder/orca/daemon-host/macos/terminal-host-placeholder/app.noindex/Orca Terminal Host.app/Contents/MacOS/orca-terminal-host'
    }
    const login = {
      ...LOGIN,
      ppid: host.pid,
      command:
        '/usr/bin/login -flpq placeholder-user /bin/bash --noprofile --norc -p -c export SHELL="$1"; shift; exec -l -- "$@" orca-tcc-login /bin/zsh /bin/zsh -l'
    }
    const shell = { ...SHELL, command: '-/bin/zsh -l' }
    const agent = {
      pid: 102,
      ppid: shell.pid,
      tty: shell.tty,
      stat: 'S+',
      command:
        'claude --plugin-dir /placeholder/orca-agent-view --dangerously-skip-permissions --effort high --resume placeholder-session'
    }
    const liveTree = [host, login, { ...shell, stat: 'S' }, agent]
    expect(resolveAgentForegroundProcessFromPs(liveTree, login.pid)).toBe('claude')
    strictCapture.mockResolvedValue(liveTree)
    expect(await confirmRootShellHasNoChildrenFromProcessTable(login.pid)).toBe(false)

    const afterAgentExit = [host, login, shell]
    expect(resolveAgentForegroundProcessFromPs(afterAgentExit, login.pid)).toBeNull()
    strictCapture.mockResolvedValue(afterAgentExit)
    expect(await confirmRootShellHasNoChildrenFromProcessTable(login.pid)).toBe(
      process.platform === 'darwin'
    )
    strictCapture.mockResolvedValue([host, login, { ...shell, command: '/bin/bash' }])
    expect(await confirmRootShellHasNoChildrenFromProcessTable(login.pid)).toBe(false)
  })

  it('proves nothing from a capture with a malformed row', async () => {
    strictCapture.mockRejectedValue(new Error('malformed process row'))
    expect(await confirmRootShellHasNoChildrenFromProcessTable(100)).toBe(false)
  })
})

describe('inspectionShowsShellAlone (the Windows proof)', () => {
  it('proves a shell alone only on an observed empty child census', () => {
    expect(
      inspectionShowsShellAlone({
        foregroundProcess: 'pwsh.exe',
        hasChildProcesses: false,
        childProcessEvidence: 'no-children'
      })
    ).toBe(true)
  })

  it.each([
    [
      'a child still runs',
      {
        foregroundProcess: 'node.exe',
        hasChildProcesses: true,
        childProcessEvidence: 'children' as const
      }
    ],
    [
      'the host could not read its process table',
      {
        foregroundProcess: 'pwsh.exe',
        hasChildProcesses: false,
        childProcessEvidence: 'unverifiable' as const
      }
    ],
    [
      'an older host sent no child census',
      { foregroundProcess: 'pwsh.exe', hasChildProcesses: false }
    ],
    [
      'the host could not be reached',
      {
        foregroundProcess: null,
        hasChildProcesses: false as const,
        verdict: 'unverifiable' as const,
        reason: 'timeout'
      }
    ]
  ])('stays unproven when %s', (_case, inspection) => {
    expect(inspectionShowsShellAlone(inspection)).toBe(false)
    expect(inspectionShowsShellAlone(null)).toBe(false)
  })
})
