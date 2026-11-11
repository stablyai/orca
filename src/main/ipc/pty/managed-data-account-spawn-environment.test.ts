import { randomUUID, createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createDaemonPtyEnvironment,
  finalizeDaemonPtyEnvironment
} from '../../daemon/pty-subprocess/spawn-environment'
import {
  buildInheritedLocalPtyEnvironment,
  enforceLocalPtySpawnEnvironmentOverrides
} from '../../providers/local-pty/local-pty-spawn-environment'
import { assemblePtySpawnEnvDeletions } from './spawn-options-assembly'
import { applyManagedDataAccountEnvironment } from '../../managed-data-accounts/launch-environment'
import { buildPtyIpcSpawnOptions } from './ipc/spawn-options'
import { createPtyIpcSpawnState } from './ipc/spawn-state'
import type { PtySpawnIpcDeps } from './ipc/spawn-types'
import { buildRuntimePtySpawnOptions } from './runtime/spawn-options'
import { createRuntimePtySpawnState } from './runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from './runtime/controller-deps'
import type * as ServiceModule from '../../managed-data-accounts/service'
import {
  MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS,
  restoreManagedDataAccountEnvironment
} from '../../../shared/managed-data-account-environment'

const selected = vi.hoisted(() => {
  const value: Record<string, string> = {}
  return { value }
})
vi.mock('../../managed-data-accounts/service', async (importOriginal) => {
  const actual = await importOriginal<typeof ServiceModule>()
  const service = new actual.ManagedDataAccountService('test-managed-root')
  vi.spyOn(service, 'launchEnvironment').mockImplementation(() => selected.value)
  return { ...actual, getManagedDataAccountService: () => service }
})

beforeEach(() => {
  for (const key of [
    ...MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS,
    'ORCA_DATA_ACCOUNT_DATA_HOME',
    'ORCA_DATA_ACCOUNT_STATE_HOME',
    'ORCA_DATA_ACCOUNT_PROVIDER',
    'ORCA_DATA_ACCOUNT_ORIGINAL_ENV'
  ]) {
    vi.stubEnv(key, undefined)
  }
  selected.value = {}
})
afterEach(() => vi.unstubAllEnvs())

describe('independent pane Claude environments', () => {
  it('canonicalizes explicit Windows stamps for old receivers and keeps caller deletions authoritative', () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const explicit = { claude_code_messaging_socket: '', SAFE_VALUE: 'kept' }
      const input = {
        env: explicit,
        callerEnvToDelete: undefined,
        agentTeamsEnvToDelete: [],
        isDaemonHostSpawn: true,
        connectionId: null,
        skipCodexHomeEnv: false,
        stripInheritedOrcaCodexHome: false,
        codexResumeHomeSelected: false,
        settings: undefined
      }
      const kept = assemblePtySpawnEnvDeletions(input)
      expect(kept.env).toEqual({ CLAUDE_CODE_MESSAGING_SOCKET: '', SAFE_VALUE: 'kept' })
      expect(kept.envToDelete).not.toContain('CLAUDE_CODE_MESSAGING_SOCKET')
      expect(kept.envToDelete).toContain('CLAUDE_CODE_MESSAGING_TOKEN')
      const deleted = assemblePtySpawnEnvDeletions({
        ...input,
        callerEnvToDelete: ['Claude_Code_Messaging_Socket']
      })
      expect(deleted.env).toEqual({ SAFE_VALUE: 'kept' })
      expect(deleted.envToDelete).toContain('CLAUDE_CODE_MESSAGING_SOCKET')
      expect(explicit).toEqual({ claude_code_messaging_socket: '', SAFE_VALUE: 'kept' })
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
    }
  })

  it.each(['local', 'daemon'])(
    '%s owns stamps only from the pane overlay through final preparation',
    (provider) => {
      const platform = process.platform
      vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', 'parent-uppercase')
      vi.stubEnv('claude_code_messaging_socket', 'parent-alias')
      vi.stubEnv('CLAUDE_CODE_SESSION_ATTENDED', 'parent-attended')
      vi.stubEnv('CLAUDE_CODE_HTTP_PROXY', 'http://user-proxy')
      const build = (env: Record<string, string>, envToDelete: string[] = []) =>
        provider === 'local'
          ? buildInheritedLocalPtyEnvironment(env, envToDelete)
          : createDaemonPtyEnvironment({ sessionId: 'pane', cols: 80, rows: 24, env, envToDelete })
      try {
        Object.defineProperty(process, 'platform', { value: 'win32' })
        const inherited = build({})
        expect(inherited.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined()
        expect(inherited.claude_code_messaging_socket).toBeUndefined()
        expect(inherited.CLAUDE_CODE_SESSION_ATTENDED).toBeUndefined()
        expect(inherited.CLAUDE_CODE_HTTP_PROXY).toBe('http://user-proxy')
        const explicit = { claude_code_messaging_socket: '' }
        const child = build(explicit)
        expect(child.CLAUDE_CODE_MESSAGING_SOCKET).toBe('')
        expect(child.claude_code_messaging_socket).toBeUndefined()
        child.Claude_Code_Messaging_Socket = 'late-parent'
        child.CLAUDE_CODE_SESSION_ATTENDED = 'late-attended'
        if (provider === 'local') {
          enforceLocalPtySpawnEnvironmentOverrides({ cols: 80, rows: 24, env: explicit }, child)
        } else {
          finalizeDaemonPtyEnvironment(child, explicit)
        }
        expect(child.CLAUDE_CODE_MESSAGING_SOCKET).toBe('')
        expect(child.Claude_Code_Messaging_Socket).toBeUndefined()
        expect(child.CLAUDE_CODE_SESSION_ATTENDED).toBeUndefined()
        const deletions = ['Claude_Code_Messaging_Socket']
        const deleted = build(explicit, deletions)
        deleted.claude_code_messaging_socket = 'late-parent'
        if (provider === 'local') {
          enforceLocalPtySpawnEnvironmentOverrides(
            { cols: 80, rows: 24, env: explicit, envToDelete: deletions },
            deleted
          )
        } else {
          finalizeDaemonPtyEnvironment(deleted, explicit, deletions)
        }
        expect(deleted.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined()
        expect(deleted.claude_code_messaging_socket).toBeUndefined()
        expect(explicit.claude_code_messaging_socket).toBe('')
        Object.defineProperty(process, 'platform', { value: 'linux' })
        const posix = build({})
        expect(posix.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined()
        expect(posix.claude_code_messaging_socket).toBe('parent-alias')
      } finally {
        Object.defineProperty(process, 'platform', { value: platform })
      }
    }
  )
})

function hash(value: string | undefined): string | undefined {
  return value === undefined ? undefined : createHash('sha256').update(value).digest('hex')
}

async function spawnDeletions(
  route: string,
  env: Record<string, string>,
  envToDelete?: string[]
): Promise<string[]> {
  const args = { cols: 80, rows: 24, envToDelete }
  if (route === 'renderer') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: option construction with no workspace reads no required dependency methods.
    const ctx = createPtyIpcSpawnState({} as PtySpawnIpcDeps, args)
    ctx.env = env
    ctx.isDaemonHostSpawn = true
    await buildPtyIpcSpawnOptions(ctx)
    ctx.finishTerminalInstall()
    return ctx.spawnOptions.envToDelete ?? []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: option construction with no workspace reads no required dependency methods.
  const ctx = createRuntimePtySpawnState({} as PtyRuntimeControllerDeps, args)
  ctx.env = env
  ctx.isDaemonHostSpawn = true
  await buildRuntimePtySpawnOptions(ctx)
  ctx.finishTerminalInstall()
  return ctx.spawnOptions.envToDelete ?? []
}

describe.each(['renderer', 'runtime'])('%s managed account daemon environment', (route) => {
  it('honors explicit user deletions and preserves unknown daemon metadata', async () => {
    const env: Record<string, string> = {}
    const envToDelete = await spawnDeletions(route, env, ['XDG_STATE_HOME'])
    const inherited = {
      XDG_DATA_HOME: join(tmpdir(), 'daemon-data'),
      XDG_STATE_HOME: join(tmpdir(), 'daemon-state'),
      OPENCODE_DB: 'daemon.db',
      ORCA_DATA_ACCOUNT_DATA_HOME: join(tmpdir(), 'future-profile'),
      ORCA_DATA_ACCOUNT_PROVIDER: 'future-provider',
      ORCA_DATA_ACCOUNT_ORIGINAL_ENV: '{"future":"opaque"}',
      ORCA_DATA_ACCOUNT_FUTURE_METADATA: 'opaque-metadata'
    }
    for (const [key, value] of Object.entries(inherited)) {
      vi.stubEnv(key, value)
    }
    const child = createDaemonPtyEnvironment({
      sessionId: 'pane',
      cols: 80,
      rows: 24,
      env,
      envToDelete
    })
    expect(child.XDG_STATE_HOME).toBeUndefined()
    for (const [key, value] of Object.entries(inherited)) {
      if (key !== 'XDG_STATE_HOME') {
        expect(child[key]).toBe(value)
      }
    }
  })

  it('preserves independent daemon defaults when main has no baseline or owned markers', async () => {
    const env: Record<string, string> = {}
    applyManagedDataAccountEnvironment(env, { launchAgent: 'opencode' })
    const envToDelete = await spawnDeletions(route, env)
    const defaults = {
      XDG_DATA_HOME: join(tmpdir(), 'persistent-daemon', 'data'),
      XDG_STATE_HOME: join(tmpdir(), 'persistent-daemon', 'state'),
      OPENCODE_DB: 'daemon.db',
      OPENCODE_AUTH_CONTENT: JSON.stringify({ fixture: { key: randomUUID() } })
    }
    for (const [key, value] of Object.entries(defaults)) {
      vi.stubEnv(key, value)
    }
    const child = createDaemonPtyEnvironment({
      sessionId: 'pane',
      cols: 80,
      rows: 24,
      env,
      envToDelete
    })
    for (const [key, value] of Object.entries(defaults)) {
      expect(hash(child[key]) === hash(value)).toBe(true)
    }
  })

  it('keeps inline System authentication out of every selected child marker', async () => {
    const secret = randomUUID()
    const baseline = JSON.stringify({ fixture: { key: secret } })
    vi.stubEnv('OPENCODE_AUTH_CONTENT', baseline)
    selected.value = {
      XDG_DATA_HOME: join(tmpdir(), 'selected-account', 'data'),
      XDG_STATE_HOME: join(tmpdir(), 'selected-account', 'state'),
      OPENCODE_AUTH_CONTENT: '',
      OPENCODE_DB: 'opencode.db'
    }
    const env: Record<string, string> = {}
    applyManagedDataAccountEnvironment(env, { launchAgent: 'opencode' })
    const envToDelete = await spawnDeletions(route, env)
    const child = createDaemonPtyEnvironment({
      sessionId: 'pane',
      cols: 80,
      rows: 24,
      env,
      envToDelete
    })
    expect(child.OPENCODE_AUTH_CONTENT).toBe('')
    expect(Object.values(child).some((value) => value.includes(secret))).toBe(false)
    selected.value = {}
    vi.stubEnv('OPENCODE_AUTH_CONTENT', undefined)
    const copied = { ...child }
    applyManagedDataAccountEnvironment(copied, { launchAgent: 'opencode' })
    expect(hash(copied.OPENCODE_AUTH_CONTENT) === hash(baseline)).toBe(true)
    for (const key of MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS) {
      vi.stubEnv(key, child[key])
    }
    for (const key of [
      'ORCA_DATA_ACCOUNT_DATA_HOME',
      'ORCA_DATA_ACCOUNT_STATE_HOME',
      'ORCA_DATA_ACCOUNT_PROVIDER',
      'ORCA_DATA_ACCOUNT_ORIGINAL_ENV'
    ]) {
      vi.stubEnv(key, child[key])
    }
    const systemDeletions = await spawnDeletions(route, copied)
    const systemChild = createDaemonPtyEnvironment({
      sessionId: 'pane',
      cols: 80,
      rows: 24,
      env: copied,
      envToDelete: systemDeletions
    })
    expect(hash(systemChild.OPENCODE_AUTH_CONTENT) === hash(baseline)).toBe(true)
    expect(systemChild.ORCA_DATA_ACCOUNT_DATA_HOME).toBeUndefined()
    restoreManagedDataAccountEnvironment(copied)
    expect(hash(copied.OPENCODE_AUTH_CONTENT) === hash(baseline)).toBe(true)
  })
})
