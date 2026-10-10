import { EventEmitter } from 'node:events'
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

import { ORCA_SSH_BRIDGE_CREDENTIAL_ENV } from '../../shared/ssh-bridge-credential-env'
import { SshBridgeCredentialRegistry } from '../runtime/rpc/ssh-bridge-credentials'
import { runHostOrcaCliPassthrough } from './ssh-remote-cli-host-passthrough'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { HOST_BOUND_SSH_BRIDGE_SCOPE } from './ssh-bridge-caller-scope.test-fixture'

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = { end: vi.fn(), on: vi.fn() }
  readonly kill = vi.fn()
}

const RUNTIME_AUTHORITY = {
  kind: 'ssh',
  targetId: 'box-1',
  connectionIncarnation: 'incarnation-1',
  attachmentId: 'attachment-1'
} as const

describe('the SSH bridge CLI child', () => {
  it('holds a credential scoped to its SSH target, never the owner token, for its lifetime only', async () => {
    const credentials = new SshBridgeCredentialRegistry()
    const child = new FakeChild()
    let spawnedEnv: NodeJS.ProcessEnv = {}
    const spawn = vi.fn((_exec: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawnedEnv = options.env
      return child
    })

    const pending = runHostOrcaCliPassthrough(
      {
        argv: ['terminal', 'list', '--json'],
        cwd: '/home/alice/wt',
        env: { ORCA_ENVIRONMENT: 'prod' },
        runtimeAuthority: RUNTIME_AUTHORITY,
        callerScope: HOST_BOUND_SSH_BRIDGE_SCOPE
      },
      {
        execPath: '/host/electron',
        cliEntryPath: '/host/app/out/cli/index.js',
        userDataPath: '/host/user-data',
        entryExists: () => true,
        hostEnv: {
          PATH: '/usr/bin',
          ORCA_ENVIRONMENT: 'owner-paired-server',
          ORCA_PAIRING_CODE: 'owner-pairing-code',
          [ORCA_SSH_BRIDGE_CREDENTIAL_ENV]: 'stale-or-forged'
        },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every ChildProcess member the passthrough touches.
        spawn: spawn as never,
        credentials
      }
    )

    const token = spawnedEnv[ORCA_SSH_BRIDGE_CREDENTIAL_ENV]
    expect(token).toMatch(/^sshb_[0-9a-f]{48}$/)
    expect(credentials.resolve(token ?? '')).toEqual(HOST_BOUND_SSH_BRIDGE_SCOPE)
    // Why: this machine's paired-server selection would route the guest's command with owner credentials.
    expect(spawnedEnv.ORCA_ENVIRONMENT).toBeUndefined()
    expect(spawnedEnv.ORCA_PAIRING_CODE).toBeUndefined()

    child.emit('close', 0)
    await pending
    expect(credentials.resolve(token ?? '')).toBeNull()
  })

  it('revokes the credential when the child cannot be launched', async () => {
    const credentials = new SshBridgeCredentialRegistry()
    const child = new FakeChild()
    let token = ''
    const spawn = vi.fn((_exec: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      token = options.env[ORCA_SSH_BRIDGE_CREDENTIAL_ENV] ?? ''
      return child
    })
    const pending = runHostOrcaCliPassthrough(
      { argv: ['status'], cwd: '/', env: {}, callerScope: HOST_BOUND_SSH_BRIDGE_SCOPE },
      {
        execPath: '/host/electron',
        cliEntryPath: '/host/app/out/cli/index.js',
        userDataPath: '/host/user-data',
        entryExists: () => true,
        hostEnv: {},
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every ChildProcess member the passthrough touches.
        spawn: spawn as never,
        credentials
      }
    )
    child.emit('error', new Error('ENOENT'))
    await expect(pending).rejects.toThrow('Failed to launch')
    expect(credentials.resolve(token)).toBeNull()
  })
})

describe('the in-process fallback bridge', () => {
  const LEGACY_FALLBACK_OPTIONS = {
    execPath: '/host/electron',
    cliEntryPath: '/host/app/out/cli/index.js',
    userDataPath: '/host/user-data',
    entryExists: () => false
  }

  it('applies the host-bound scope to orchestration it would otherwise relay as owner', async () => {
    const runtime = new OrcaRuntimeService()
    const result = await runRemoteOrcaCli(
      runtime,
      {
        argv: ['orchestration', 'send', '--to', 'term_local', '--subject', 'hi', '--json'],
        cwd: '/home/alice/repo',
        env: { ORCA_TERMINAL_HANDLE: 'term_remote' },
        callerScope: HOST_BOUND_SSH_BRIDGE_SCOPE
      },
      LEGACY_FALLBACK_OPTIONS
    )
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout).error.code).toBe('forbidden')
  })

  it("filters the fallback terminal list to the bridged host's terminals", async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        {
          handle: 'term_local',
          ptyId: 'pty-1',
          worktreeId: 'repo::/Users/me/secret',
          worktreePath: '/Users/me/secret',
          branch: 'main',
          tabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'owner shell',
          connected: true,
          writable: true,
          lastOutputAt: null,
          preview: 'owner secrets',
          executionHostId: 'local'
        }
      ],
      totalCount: 1,
      truncated: false
    })
    const result = await runRemoteOrcaCli(
      runtime,
      {
        argv: ['terminal', 'list', '--json'],
        cwd: '/home/alice/repo',
        env: {},
        callerScope: HOST_BOUND_SSH_BRIDGE_SCOPE
      },
      LEGACY_FALLBACK_OPTIONS
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('owner secrets')
    expect(JSON.parse(result.stdout).result.terminals).toEqual([])
  })
})
