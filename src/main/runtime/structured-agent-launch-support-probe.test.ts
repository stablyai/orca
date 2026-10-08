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

/** A stand-in `opencode` that answers `--version` with `version`; never a real agent CLI. */
async function fakeOpencode(dir: string, version: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'opencode')
  await writeFile(file, `#!/bin/sh\necho ${version}\n`)
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
  return createAcpStructuredLaunchResolver(acpLaunchSpecFor('opencode')!, {
    store: {
      getRecord: () => ({
        ...agentSessionRecordFixture(),
        provider: 'opencode',
        providerHandleChain: [],
        accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } }
      })
    },
    readJournal: () => null,
    resolveWorkspacePath: async () => root,
    resolveEnvironment: async () => loginShell.env,
    resolveLaunchEnv: () => settings.agentDefaultEnv?.opencode ?? {},
    resolveCommandSettings: () => settings,
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
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-opencode-probe-'))
  shellBin = await fakeOpencode(join(root, 'homebrew'), '2.0.21')
  privateBin = await fakeOpencode(join(root, 'oc-prefix', 'bin'), '1.18.31')
  // Orca's resolved login-shell PATH, with a 2.x `opencode` first.
  loginShell.env = { PATH: `${shellBin}:/usr/bin:/bin`, HOME: root }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const base = { nativeChatInheritShellEnvironment: true, nativeChatShellEnvironmentVariables: [] }

// Real `--version` runs against stand-in scripts: the whole create check, not a mocked probe.
describe.skipIf(process.platform === 'win32')(
  'OpenCode create check and launch, real probe',
  () => {
    it('asks the OpenCode the per-agent PATH names, not the one first on the shell PATH', async () => {
      const settings = {
        ...base,
        agentDefaultEnv: { opencode: { PATH: `${privateBin}:/usr/bin:/bin` } }
      }
      expect(await structuredAgentSupportsLaunch('opencode', 'id:w', runtimeWith(settings))).toBe(
        true
      )
      expect((await launchWith(settings)).command).toBe(join(privateBin, 'opencode'))
    })

    it('keeps 2.x first on PATH on the terminal chat when nothing points elsewhere', async () => {
      const settings = { ...base, agentDefaultEnv: {} }
      expect(await structuredAgentSupportsLaunch('opencode', 'id:w', runtimeWith(settings))).toBe(
        false
      )
    })

    it('checks and launches the binary the Command setting names', async () => {
      const settings = {
        ...base,
        agentDefaultEnv: {},
        agentCmdOverrides: { opencode: join(privateBin, 'opencode') }
      }
      expect(await structuredAgentSupportsLaunch('opencode', 'id:w', runtimeWith(settings))).toBe(
        true
      )
      expect((await launchWith(settings)).command).toBe(join(privateBin, 'opencode'))
    })

    it('refuses the launch with the setting named when the Command is not runnable', async () => {
      const settings = {
        ...base,
        agentDefaultEnv: {},
        agentCmdOverrides: { opencode: join(root, 'missing', 'opencode') }
      }
      // Admitted, so the chat states why rather than silently opening a terminal.
      expect(await structuredAgentSupportsLaunch('opencode', 'id:w', runtimeWith(settings))).toBe(
        true
      )
      await expect(launchWith(settings)).rejects.toMatchObject({
        name: 'AgentSessionPreSpawnError',
        reason: 'agentCommandNotRunnable'
      })
    })
  }
)
