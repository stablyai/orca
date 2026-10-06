import { describe, expect, it } from 'vitest'
import type { ProviderProcessLaunch } from './provider-process-launch'
import {
  createProviderSpawnSpec,
  POSIX_PROVIDER_SUPERVISOR_SCRIPT,
  PROVIDER_SIGTERM_GRACE_MS,
  PROVIDER_STDIN_END_GRACE_MS,
  supervisedPosixLaunch
} from './provider-process-supervisor'

const launch: ProviderProcessLaunch = {
  command: '/opt/codex',
  args: ['app-server', '--flag'],
  cwd: '/work/repo',
  env: { CODEX_HOME: '/tmp/codex' }
}
const command = { command: launch.command, args: launch.args, cwd: launch.cwd }

describe('structured provider supervision', () => {
  it('wraps POSIX launches in a detached supervisor and preserves the launch spec', () => {
    const childEnv = { PATH: '/bin', CODEX_HOME: '/tmp/codex' }
    const spec = supervisedPosixLaunch(command, childEnv)

    expect(spec.command).toBe(process.execPath)
    expect(spec.args).toEqual(['-e', POSIX_PROVIDER_SUPERVISOR_SCRIPT])
    expect(spec.env.PATH).toBe('/bin')
    expect(
      JSON.parse(Buffer.from(spec.env.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString())
    ).toEqual(
      expect.objectContaining({
        command: '/opt/codex',
        args: ['app-server', '--flag'],
        cwd: '/work/repo',
        ownerPid: process.pid,
        stdinEndGraceMs: PROVIDER_STDIN_END_GRACE_MS,
        sigtermGraceMs: PROVIDER_SIGTERM_GRACE_MS
      })
    )
    expect(
      JSON.parse(Buffer.from(spec.env.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString())
    ).not.toHaveProperty('env')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain(
      'delete childEnv.ORCA_PROVIDER_SUPERVISOR_SPEC'
    )
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain('delete childEnv.ELECTRON_RUN_AS_NODE')
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain(
      "process.stdin.once('close', scheduleOwnerShutdown)"
    )
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).not.toContain('process.ppid === 1')
  })

  it('only accepts a resolved env, never a launch whose env it would ignore', () => {
    // @ts-expect-error env/envToDelete are resolved by createProviderSpawnSpec, not here.
    const spec = supervisedPosixLaunch(launch, { PATH: '/bin' })

    expect(spec.env).not.toHaveProperty('CODEX_HOME')
  })

  it('refuses a grace longer than recovery waits before SIGKILL', () => {
    const stdinEnd = (stdinEndGraceMs: number) => () =>
      supervisedPosixLaunch(command, {}, { stdinEndGraceMs })
    const sigterm = (sigtermGraceMs: number) => () =>
      supervisedPosixLaunch(command, {}, { sigtermGraceMs })

    expect(stdinEnd(PROVIDER_STDIN_END_GRACE_MS)).not.toThrow()
    expect(stdinEnd(PROVIDER_STDIN_END_GRACE_MS + 1)).toThrow(RangeError)
    expect(sigterm(PROVIDER_SIGTERM_GRACE_MS)).not.toThrow()
    expect(sigterm(PROVIDER_SIGTERM_GRACE_MS + 1)).toThrow(RangeError)
  })

  it('uses direct provider spawning on Windows because the job owns the tree', () => {
    expect(createProviderSpawnSpec(launch, { PATH: '/bin' }, 'win32')).toEqual({
      program: '/opt/codex',
      args: ['app-server', '--flag'],
      env: { PATH: '/bin', CODEX_HOME: '/tmp/codex' },
      cwd: '/work/repo',
      detached: false,
      supervised: false
    })
  })

  it.each(['win32', 'darwin', 'linux'] as const)(
    'applies launch environment overrides and deletions on %s',
    (platform) => {
      const baseEnv = { PATH: '/bin', AGENT_HOME: '/inherited', PARENT_AGENT: 'parent' }
      const overlay = { AGENT_HOME: '/pinned', LAUNCH_ONLY: 'added', PARENT_AGENT: 'overlay' }
      const spec = createProviderSpawnSpec(
        { command: 'provider', args: [], env: overlay, envToDelete: ['PARENT_AGENT'] },
        baseEnv,
        platform
      )

      expect(spec.env).toMatchObject({ PATH: '/bin', AGENT_HOME: '/pinned', LAUNCH_ONLY: 'added' })
      expect(spec.env).not.toHaveProperty('PARENT_AGENT')
      expect(baseEnv.PARENT_AGENT).toBe('parent')
      expect(baseEnv.AGENT_HOME).toBe('/inherited')
      expect(overlay.PARENT_AGENT).toBe('overlay')
    }
  )
})
