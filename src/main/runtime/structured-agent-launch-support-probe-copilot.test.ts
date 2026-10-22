import { createAcpStructuredLaunchResolver } from './structured-agent-launch-composition.test-support'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
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

async function fakeCopilot(dir: string, version: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'copilot')
  await writeFile(
    file,
    `#!/bin/sh\necho "GitHub Copilot CLI ${version}."\necho "Run 'copilot update' to check for updates."\n`
  )
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
  return createAcpStructuredLaunchResolver(acpLaunchSpecFor('copilot')!, {
    store: {
      getRecord: () => ({
        ...agentSessionRecordFixture(),
        provider: 'copilot',
        providerHandleChain: [],
        accountHome: { variable: 'COPILOT_HOME', path: join(root, '.copilot') }
      }),
      pinLaunchDirectory: vi.fn()
    },
    readJournal: () => null,
    resolveWorkspacePath: async () => root,
    resolveEnvironment: async () => loginShell.env,
    resolveLaunchEnv: () => settings.agentDefaultEnv?.copilot ?? {},
    resolveCommandSettings: () => settings,
    inheritedEnv: {}
  })({
    identity: {
      sessionId: 'session-alpha-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'copilot',
      providerHandle: null
    }
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-copilot-probe-'))
  shellBin = await fakeCopilot(join(root, 'shell-bin'), '1.0.97')
  privateBin = await fakeCopilot(join(root, 'copilot-prefix', 'bin'), '1.0.98')
  loginShell.env = { PATH: `${shellBin}:/usr/bin:/bin`, HOME: root }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const base = { nativeChatInheritShellEnvironment: true, nativeChatShellEnvironmentVariables: [] }
const workspace = async () => root

describe.skipIf(process.platform === 'win32')('Copilot create check and launch, real probe', () => {
  it('checks and launches the binary the Command setting names, through the captured version form', async () => {
    const settings = {
      ...base,
      agentDefaultEnv: {},
      agentCmdOverrides: { copilot: join(privateBin, 'copilot') }
    }
    expect(await structuredAgentSupportsLaunch('copilot', workspace, runtimeWith(settings))).toBe(
      true
    )
    const launch = await launchWith(settings)
    expect(launch.command).toBe(join(privateBin, 'copilot'))
    expect(launch.args).toEqual(['--acp', '--stdio'])
  })

  it('asks the Copilot the per-agent PATH names, not the one first on the shell PATH', async () => {
    const settings = {
      ...base,
      agentDefaultEnv: { copilot: { PATH: `${privateBin}:/usr/bin:/bin` } }
    }
    expect(await structuredAgentSupportsLaunch('copilot', workspace, runtimeWith(settings))).toBe(
      true
    )
    expect((await launchWith(settings)).command).toBe(join(privateBin, 'copilot'))
  })

  it('keeps a Copilot older than 1.0.98 on its terminal-backed chat', async () => {
    const settings = { ...base, agentDefaultEnv: {} }
    expect(await structuredAgentSupportsLaunch('copilot', workspace, runtimeWith(settings))).toBe(
      false
    )
  })

  it('refuses the launch with the setting named when the Command is not runnable', async () => {
    const settings = {
      ...base,
      agentDefaultEnv: {},
      agentCmdOverrides: { copilot: join(root, 'missing', 'copilot') }
    }
    // Admitted, so the chat states why rather than silently opening a terminal.
    expect(await structuredAgentSupportsLaunch('copilot', workspace, runtimeWith(settings))).toBe(
      true
    )
    await expect(launchWith(settings)).rejects.toMatchObject({
      name: 'AgentSessionPreSpawnError',
      reason: 'agentCommandNotRunnable'
    })
  })
})
