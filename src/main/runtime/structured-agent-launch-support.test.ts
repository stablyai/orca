import { createAcpStructuredLaunchResolver } from './structured-agent-launch-composition.test-support'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { structuredAgentSupportsLaunch } from './structured-agent-launch-support'
import { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'
import type * as LoginShellModule from '../startup/login-shell-environment'
import type * as VersionProbeModule from '../agent-cli-version-probe'
import {
  resetLoginShellEnvironmentCacheForTests,
  type ResolveLoginShellEnvironmentOptions as LoginShellOptions
} from '../startup/login-shell-environment'

const { readVersion, loginShell } = vi.hoisted(() => {
  const loginShell: {
    env: NodeJS.ProcessEnv
    spawn: ReturnType<typeof vi.fn<() => Promise<NodeJS.ProcessEnv | null>>>
  } = {
    env: {},
    // Each call is one shell run through the real cache; a test can hold one open.
    spawn: vi.fn(async (): Promise<NodeJS.ProcessEnv | null> => loginShell.env)
  }
  return { readVersion: vi.fn<VersionProbeModule.AgentCliVersionReader>(), loginShell }
})
vi.mock('../agent-cli-version-probe', async (importOriginal) => {
  const real = await importOriginal<typeof VersionProbeModule>()
  return {
    ...real,
    checkAgentCliVersion: (...[input, minimums]: Parameters<typeof real.checkAgentCliVersion>) =>
      real.checkAgentCliVersion(input, minimums, readVersion)
  }
})
vi.mock('../startup/login-shell-environment', async (importOriginal) => {
  const real = await importOriginal<typeof LoginShellModule>()
  return {
    ...real,
    resolveLoginShellEnvironment: (options: LoginShellOptions = {}) =>
      real.resolveLoginShellEnvironment({
        ...options,
        shellOverride: '/bin/test-login-shell',
        spawner: loginShell.spawn
      })
  }
})

let bin: string
const asked: Parameters<VersionProbeModule.AgentCliVersionReader>[0][] = []
function installedVersion(version: string): void {
  readVersion.mockImplementation(async (input) => {
    asked.push(input)
    return { version }
  })
}

const settings = {
  agentDefaultEnv: { opencode: { OPENCODE_EXTRA: '1' } },
  nativeChatInheritShellEnvironment: true,
  nativeChatShellEnvironmentVariables: []
}
const runtime = { requireStore: () => ({ getSettings: () => settings }) }
const workspace = vi.fn(async () => '/repo/worktree')

beforeEach(async () => {
  asked.length = 0
  bin = await mkdtemp(join(tmpdir(), 'orca-opencode-bin-'))
  const opencode = join(bin, 'opencode')
  await writeFile(opencode, '#!/bin/sh\n')
  await chmod(opencode, 0o755)
  loginShell.env = { PATH: bin, HOME: '/home/user' }
  loginShell.spawn.mockClear()
  resetLoginShellEnvironmentCacheForTests()
})
afterEach(async () => {
  readVersion.mockReset()
  workspace.mockClear()
  await rm(bin, { recursive: true, force: true })
})

describe('structuredAgentSupportsLaunch', () => {
  it('asks nothing for an agent whose location alone decides', async () => {
    expect(await structuredAgentSupportsLaunch('grok', workspace, runtime)).toBe(true)
    expect(readVersion).not.toHaveBeenCalled()
    expect(workspace).not.toHaveBeenCalled()
  })

  it('allows OpenCode from its minimums, asking in the workspace with the launch env', async () => {
    for (const [version, supported] of [
      ['1.18.31', true],
      ['2.0.14', true],
      ['2.1.0-beta.1', true],
      ['3.0.0', true],
      ['1.18.30', false],
      ['2.0.13', false]
    ] as const) {
      installedVersion(version)
      expect(await structuredAgentSupportsLaunch('opencode', workspace, runtime)).toBe(supported)
    }
    expect(asked[0]).toMatchObject({
      cwd: '/repo/worktree',
      env: { PATH: bin, OPENCODE_EXTRA: '1', OPENCODE_CLIENT: 'acp' }
    })
  })

  it.skipIf(process.platform === 'win32')(
    'shares one shell reread between create checks and launches that find no OpenCode',
    async () => {
      installedVersion('1.18.31')
      // A name only the reread PATH has, so no OpenCode on the machine running the test answers.
      const name = `opencode-installed-${process.pid}`
      await writeFile(join(bin, name), '#!/bin/sh\n')
      await chmod(join(bin, name), 0o755)
      const installing = {
        ...runtime,
        requireStore: () => ({
          getSettings: () => ({ ...settings, agentCmdOverrides: { opencode: name } })
        })
      }
      loginShell.env = { PATH: join(bin, 'not-installed'), HOME: '/home/user' }
      // A chat launched from this host reads the same snapshot.
      const launches = createStructuredAgentEnvironmentResolvers({})
      expect((await launches.resolveBaseEnvironment()).PATH).toBe(join(bin, 'not-installed'))
      const reread = Promise.withResolvers<NodeJS.ProcessEnv | null>()
      loginShell.spawn.mockReturnValueOnce(reread.promise)
      const askedAt = Date.now()
      const checks = Array.from({ length: 8 }, () =>
        structuredAgentSupportsLaunch('opencode', workspace, installing)
      )
      const launchMiss = launches.refreshAfterMissingProgram(askedAt)
      await vi.waitFor(() => expect(loginShell.spawn).toHaveBeenCalledTimes(2))
      reread.resolve({ PATH: bin, HOME: '/home/user' })
      expect(await Promise.all(checks)).toEqual(Array(8).fill(true))
      await launchMiss
      expect(loginShell.spawn).toHaveBeenCalledTimes(2)
      expect(asked.map(({ program }) => program)).toEqual(Array(8).fill(join(bin, name)))
      expect((await launches.resolveBaseEnvironment()).PATH).toBe(bin)
    }
  )

  it('never rereads the shell for an OpenCode that is installed but unsupported', async () => {
    installedVersion('1.18.30')
    expect(await structuredAgentSupportsLaunch('opencode', workspace, runtime)).toBe(false)
    expect(await structuredAgentSupportsLaunch('opencode', workspace, runtime)).toBe(false)
    // Only the first read of the shell; neither refusal asked for another.
    expect(loginShell.spawn).toHaveBeenCalledOnce()
    expect(asked).toHaveLength(2)
  })

  it('allows a version it cannot read, and refuses a binary that does not start', async () => {
    readVersion.mockResolvedValue({ version: null })
    expect(await structuredAgentSupportsLaunch('opencode', workspace, runtime)).toBe(true)
    readVersion.mockResolvedValue({ version: null, started: false })
    expect(await structuredAgentSupportsLaunch('opencode', workspace, runtime)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'asks about the same binary the launch then spawns',
    async () => {
      installedVersion('1.18.31')
      await structuredAgentSupportsLaunch('opencode', workspace, runtime)
      const launch = await createAcpStructuredLaunchResolver(acpLaunchSpecFor('opencode')!, {
        store: {
          getRecord: () => ({
            ...agentSessionRecordFixture(),
            provider: 'opencode',
            providerHandleChain: [],
            accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } }
          }),
          pinLaunchDirectory: vi.fn()
        },
        readJournal: () => null,
        resolveWorkspacePath: async () => '/repo/worktree',
        resolveEnvironment: async () => loginShell.env,
        resolveLaunchEnv: () => settings.agentDefaultEnv.opencode,
        inheritedEnv: {}
      })({
        identity: {
          sessionId: 'session-alpha-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'opencode',
          providerHandle: null
        }
      })
      expect(launch.command).toBe(join(bin, 'opencode'))
      expect(asked.map(({ program }) => program)).toEqual([launch.command, launch.command])
    }
  )
})
