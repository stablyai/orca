import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import path from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import { scanWorkspacePorts } from './local-workspace-port-scanner'
import {
  attributePortToWorkspace,
  attributePortsToWorkspaces,
  normalizeWorkspacePortProbes
} from './local-workspace-port-attribution'
import { resetWorkspacePortScanTimeoutBackoffForTests } from './local-workspace-port-scan-state'

const runPortScanCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./port-scan-command-client', () => ({
  runPortScanCommand: (command: string, args: string[], operation?: string) =>
    command === '/usr/sbin/netstat'
      ? Promise.resolve({
          stdout:
            'Active Internet connections (including servers)\nProto Recv-Q Send-Q Local Address Foreign Address (state)\ntcp4 0 0 127.0.0.1.5173 *.* LISTEN\n',
          spawnMs: 5
        })
      : runPortScanCommandMock(command, args, operation),
  isPortScanWorkerUnavailableError: () => false
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})

const LSOF_LISTEN_OUTPUT = ['p123', 'cnode', 'd0x1', 'n127.0.0.1:5173'].join('\n')

function urlWatcherStub(): { lookup: () => undefined; reconcileWorkspaces: Mock } {
  return { lookup: () => undefined, reconcileWorkspaces: vi.fn() }
}

const worktrees = [
  {
    id: 'repo::/repo',
    repoId: 'repo',
    displayName: 'main',
    path: '/repo'
  },
  {
    id: 'repo::/repo/worktrees/feature',
    repoId: 'repo',
    displayName: 'feature',
    path: '/repo/worktrees/feature'
  }
]

describe('attributePortToWorkspace', () => {
  it('requires command-line path boundary evidence', () => {
    const owner = attributePortToWorkspace(
      { commandLine: `node ${path.posix.resolve('/repo/worktrees/feature-other/server.js')}` },
      [worktrees[1]]
    )

    expect(owner).toBeUndefined()
  })
})

describe('scanWorkspacePorts with delayed process creation', () => {
  afterEach(() => {
    resetWorkspacePortScanTimeoutBackoffForTests()
    vi.restoreAllMocks()
    runPortScanCommandMock.mockReset()
  })

  // EDR spawn delay must not consume the command execution budget (#11161).

  // Missing metadata cannot prove listener absence; eviction would lose PTY-only URL evidence (#11161).

  // Skipped metadata cycles must retain attribution instead of moving workspace ports into External (#11161).

  it('does not hand carried-forward metadata to a different listener', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let listenOutput = LSOF_LISTEN_OUTPUT
    let listenSpawnMs = 5
    runPortScanCommandMock.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/sbin/lsof' && args.includes('-iTCP')) {
        return { stdout: listenOutput, spawnMs: listenSpawnMs }
      }
      return {
        stdout: command === '/usr/sbin/lsof' ? ['p123', 'n/repo'].join('\n') : '',
        spawnMs: 5
      }
    })

    await scanWorkspacePorts(worktrees, urlWatcherStub())
    listenOutput = ['p123', 'cnode', 'n127.0.0.1:9999'].join('\n')
    listenSpawnMs = 4_200
    const skipped = await scanWorkspacePorts(worktrees, urlWatcherStub())

    expect(skipped.ports[0]?.kind).toBe('external')
  })
})

describe('scan-local workspace attribution', () => {
  it('preserves cwd precedence, root boundaries and probe ties across a listener batch', () => {
    const probes = normalizeWorkspacePortProbes([
      { id: 'first', repoId: 'r', displayName: 'first', path: '/repo/bb' },
      { id: 'second', repoId: 'r', displayName: 'second', path: '/repo/aa' },
      { id: 'root', repoId: 'r', displayName: 'root', path: '/' },
      { id: 'spaces', repoId: 'r', displayName: 'spaces', path: '/a /a' },
      { id: 'long', repoId: 'r', displayName: 'long', path: '/a /b' },
      { id: 'suffix', repoId: 'r', displayName: 'suffix', path: '/b' },
      { id: 'unicode', repoId: 'r', displayName: 'unicode', path: '/repo/🌊' }
    ])
    probes.push({ ...probes[1], normalizedPath: '/repo/bb' })
    const listeners = [
      { cwd: '/repo/aa/server', commandLine: 'node /repo/bb/start' },
      { commandLine: 'node /repo/aa/x /repo/bb/y' },
      { cwd: '/outside' },
      { cwd: '/' },
      { commandLine: 'node /repo/bb-other/server' },
      { commandLine: 'node --dir=/repo/bb:5173' },
      { commandLine: 'z/a /a /a' },
      { commandLine: 'z/a /b' },
      { commandLine: 'node /a /b' },
      { commandLine: 'node --dir=/repo/🌊:3000' },
      { cwd: '/repo/🌊/server' }
    ].map((evidence, i) => ({ host: '127.0.0.1', port: 3000 + i, ...evidence }))

    expect(
      attributePortsToWorkspaces(listeners, probes).map(({ owner }) =>
        owner ? [owner.worktreeId, owner.confidence] : null
      )
    ).toEqual([
      ['second', 'cwd'],
      ['first', 'command'],
      null,
      ['root', 'cwd'],
      null,
      ['first', 'command'],
      ['spaces', 'command'],
      ['suffix', 'command'],
      ['long', 'command'],
      ['unicode', 'command'],
      ['unicode', 'cwd']
    ])
  })
})
