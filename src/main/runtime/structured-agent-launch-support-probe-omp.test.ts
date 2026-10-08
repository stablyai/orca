import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { createAcpStructuredLaunchResolver } from '../acp/acp-structured-launch-resolution'
import { structuredAgentSupportsLaunch } from './structured-agent-launch-support'

const { loginShell } = vi.hoisted(() => {
  const loginShell: { env: Record<string, string> } = { env: {} }
  return { loginShell }
})
vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async () => loginShell.env
}))

type Settings = Pick<
  GlobalSettings,
  'agentDefaultEnv' | 'nativeChatInheritShellEnvironment' | 'nativeChatShellEnvironmentVariables'
> &
  Partial<Pick<GlobalSettings, 'agentCmdOverrides'>>

let root: string
let shellBin: string
let privateBin: string

/** A stand-in `omp` that answers `--version` as OMP does; never the real agent CLI. */
async function fakeOmp(dir: string, version: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'omp')
  await writeFile(file, `#!/bin/sh\necho omp/${version}\n`)
  await chmod(file, 0o755)
  return dir
}

function runtimeWith(settings: Settings) {
  return {
    requireStore: () => ({ getSettings: () => settings }),
    resolveRuntimeFileTarget: async () => ({ worktree: { path: root } })
  }
}

function launchWith(settings: Settings) {
  return createAcpStructuredLaunchResolver(acpLaunchSpecFor('omp')!, {
    store: {
      getRecord: () => ({
        ...agentSessionRecordFixture(),
        provider: 'omp',
        providerHandleChain: [],
        accountHome: { variable: 'PI_CODING_AGENT_DIR', path: join(root, '.omp', 'agent') }
      })
    },
    readJournal: () => null,
    resolveWorkspacePath: async () => root,
    resolveEnvironment: async () => loginShell.env,
    resolveLaunchEnv: () => settings.agentDefaultEnv?.omp ?? {},
    resolveCommandSettings: () => settings,
    inheritedEnv: {}
  })({
    identity: {
      sessionId: 'session-alpha-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'omp',
      providerHandle: null
    }
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-omp-probe-'))
  shellBin = await fakeOmp(join(root, 'shell-bin'), '16.2.0')
  privateBin = await fakeOmp(join(root, 'omp-prefix', 'bin'), '17.0.5')
  // Orca's resolved login-shell PATH, with an OMP older than ACP support first.
  loginShell.env = { PATH: `${shellBin}:/usr/bin:/bin`, HOME: root }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const base = { nativeChatInheritShellEnvironment: true, nativeChatShellEnvironmentVariables: [] }

// Real `--version` runs against stand-in scripts: the whole create check, not a mocked probe.
describe.skipIf(process.platform === 'win32')('OMP create check and launch, real probe', () => {
  it('checks and launches the binary the Command setting names', async () => {
    const settings = {
      ...base,
      agentDefaultEnv: {},
      agentCmdOverrides: { omp: join(privateBin, 'omp') }
    }
    expect(await structuredAgentSupportsLaunch('omp', 'id:w', runtimeWith(settings))).toBe(true)
    const launch = await launchWith(settings)
    expect(launch.command).toBe(join(privateBin, 'omp'))
    expect(launch.args).toEqual(['acp'])
  })

  it('asks the OMP the per-agent PATH names, not the one first on the shell PATH', async () => {
    const settings = { ...base, agentDefaultEnv: { omp: { PATH: `${privateBin}:/usr/bin:/bin` } } }
    expect(await structuredAgentSupportsLaunch('omp', 'id:w', runtimeWith(settings))).toBe(true)
    expect((await launchWith(settings)).command).toBe(join(privateBin, 'omp'))
  })

  it('keeps an OMP older than 17.0.5 on its terminal-backed chat', async () => {
    const settings = { ...base, agentDefaultEnv: {} }
    expect(await structuredAgentSupportsLaunch('omp', 'id:w', runtimeWith(settings))).toBe(false)
  })

  it('refuses the launch with the setting named when the Command is not runnable', async () => {
    const settings = {
      ...base,
      agentDefaultEnv: {},
      agentCmdOverrides: { omp: join(root, 'missing', 'omp') }
    }
    // Admitted, so the chat states why rather than silently opening a terminal.
    expect(await structuredAgentSupportsLaunch('omp', 'id:w', runtimeWith(settings))).toBe(true)
    await expect(launchWith(settings)).rejects.toMatchObject({
      name: 'AgentSessionPreSpawnError',
      reason: 'agentCommandNotRunnable'
    })
  })
})
