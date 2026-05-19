import { describe, expect, it } from 'vitest'
import {
  attributePortToWorkspace,
  isContainerProcess,
  parseLsofListeningOutput,
  parseNetstatListeningOutput,
  parseProcNetTcp
} from './local-workspace-port-scanner'

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

describe('local workspace port scanner parsing', () => {
  it('parses lsof field output into listening ports', () => {
    const ports = parseLsofListeningOutput(
      ['p123', 'cnode', 'n127.0.0.1:5173', 'p456', 'cnginx', 'n*:8080'].join('\n')
    )

    expect(ports).toEqual([
      { pid: 123, processName: 'node', host: '127.0.0.1', port: 5173 },
      { pid: 456, processName: 'nginx', host: '*', port: 8080 }
    ])
  })

  it('parses multiple lsof listening ports for the same process', () => {
    const ports = parseLsofListeningOutput(
      ['p123', 'cnode', 'n127.0.0.1:5173', 'n127.0.0.1:55173'].join('\n')
    )

    expect(ports).toEqual([
      { pid: 123, processName: 'node', host: '127.0.0.1', port: 5173 },
      { pid: 123, processName: 'node', host: '127.0.0.1', port: 55173 }
    ])
  })

  it('parses Windows netstat listening rows', () => {
    const ports = parseNetstatListeningOutput(
      [
        'Proto  Local Address          Foreign Address        State           PID',
        'TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       4242',
        'TCP    [::]:5173              [::]:0                 LISTENING       5151'
      ].join('\n')
    )

    expect(ports).toEqual([
      { host: '127.0.0.1', port: 3000, pid: 4242 },
      { host: '::', port: 5173, pid: 5151 }
    ])
  })

  it('parses Linux proc tcp listeners', () => {
    const ports = parseProcNetTcp(
      [
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
        '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 12345 1 0000000000000000 100 0 0 10 0'
      ].join('\n')
    )

    expect(ports).toEqual([{ host: '127.0.0.1', port: 3000, inode: 12345 }])
  })
})

describe('attributePortToWorkspace', () => {
  it('uses cwd ancestry and picks the deepest matching worktree', () => {
    const owner = attributePortToWorkspace(
      { cwd: '/repo/worktrees/feature/packages/app', commandLine: 'node server.js' },
      worktrees
    )

    expect(owner).toMatchObject({
      worktreeId: 'repo::/repo/worktrees/feature',
      displayName: 'feature',
      confidence: 'cwd'
    })
  })

  it('falls back to command-line path evidence', () => {
    const owner = attributePortToWorkspace(
      { commandLine: 'node /repo/worktrees/feature/node_modules/vite/bin/vite.js' },
      worktrees
    )

    expect(owner).toMatchObject({
      worktreeId: 'repo::/repo/worktrees/feature',
      confidence: 'command'
    })
  })

  it('requires command-line path boundary evidence', () => {
    const owner = attributePortToWorkspace(
      { commandLine: 'node /repo/worktrees/feature-other/server.js' },
      [worktrees[1]]
    )

    expect(owner).toBeUndefined()
  })

  it('keeps path case significant on case-sensitive platforms', () => {
    const owner = attributePortToWorkspace({ cwd: '/Repo/worktrees/feature' }, worktrees)

    if (process.platform === 'win32') {
      expect(owner).toMatchObject({ worktreeId: 'repo::/repo/worktrees/feature' })
    } else {
      expect(owner).toBeUndefined()
    }
  })

  it('does not guess when there is no worktree evidence', () => {
    const owner = attributePortToWorkspace({ cwd: '/Applications/ContainerRuntime.app' }, worktrees)

    expect(owner).toBeUndefined()
  })
})

describe('container process classification', () => {
  it('detects common container listener owners without workspace attribution', () => {
    expect(isContainerProcess({ processName: 'com.container.backend' })).toBe(true)
    expect(isContainerProcess({ processName: 'com.vendor.backend' })).toBe(true)
    expect(isContainerProcess({ commandLine: '/usr/bin/container-runtime port-forward' })).toBe(
      true
    )
    expect(isContainerProcess({ processName: 'node', commandLine: 'node server.js' })).toBe(false)
  })
})
