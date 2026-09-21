import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/host/app'
  }
}))
vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/host/user-data'
}))

import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { HostCliPassthroughOptions } from './ssh-remote-cli-host-passthrough'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

// Why: a missing CLI entry forces the legacy in-process bridge, the transport
// an SSH-hosted agent actually reaches `terminal list` through.
const LEGACY_FALLBACK_OPTIONS: HostCliPassthroughOptions = {
  execPath: '/host/electron',
  cliEntryPath: '/host/app/out/cli/index.js',
  userDataPath: '/host/user-data',
  entryExists: () => false
}

describe('remote CLI bridge terminal list', () => {
  it('relays the execution host and scope to an SSH-hosted caller', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        {
          handle: 'term_remote',
          ptyId: 'ssh:box-1@@pty-7',
          worktreeId: 'repo-ssh::/remote/wt',
          worktreePath: '/remote/wt',
          branch: 'main',
          tabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'worker',
          connected: true,
          writable: true,
          lastOutputAt: null,
          preview: '',
          executionHostId: 'ssh:box-1'
        }
      ],
      totalCount: 1,
      truncated: false,
      hostScope: { hostIds: ['ssh:box-1'], omittedHostIds: ['local'] }
    })

    const result = await runRemoteOrcaCli(
      runtime,
      { argv: ['terminal', 'list', '--json'], cwd: '/home/alice/repo', env: {} },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      result: {
        terminals: { executionHostId?: string }[]
        hostScope?: { hostIds: string[]; omittedHostIds: string[] }
      }
    }
    expect(payload.result.terminals[0]?.executionHostId).toBe('ssh:box-1')
    expect(payload.result.hostScope).toEqual({
      hostIds: ['ssh:box-1'],
      omittedHostIds: ['local']
    })
  })
})
