import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { createAcpStructuredLaunchResolver } from '../acp/acp-structured-launch-resolution'
import { structuredAgentSupportsLaunch } from './structured-agent-launch-support'

const { probeAgentCliVersion, loginShell } = vi.hoisted(() => {
  const loginShell: { env: Record<string, string> } = { env: {} }
  return { probeAgentCliVersion: vi.fn(), loginShell }
})
vi.mock('../agent-cli-version-probe', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeAgentCliVersion
}))
vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async () => loginShell.env
}))

let bin: string
const asked: { program: string; cwd: string; env: Record<string, string> }[] = []
function installedVersion(version: string): void {
  probeAgentCliVersion.mockImplementation(async (input, supports) => {
    asked.push(input)
    return supports(version)
  })
}

const settings = {
  agentDefaultEnv: { opencode: { OPENCODE_EXTRA: '1' } },
  nativeChatInheritShellEnvironment: true,
  nativeChatShellEnvironmentVariables: []
}
const runtime = {
  requireStore: () => ({ getSettings: () => settings }),
  resolveRuntimeFileTarget: vi.fn(async () => ({ worktree: { path: '/repo/worktree' } }))
}

beforeEach(async () => {
  asked.length = 0
  bin = await mkdtemp(join(tmpdir(), 'orca-opencode-bin-'))
  const opencode = join(bin, 'opencode')
  await writeFile(opencode, '#!/bin/sh\n')
  await chmod(opencode, 0o755)
  loginShell.env = { PATH: bin, HOME: '/home/user' }
})
afterEach(async () => {
  probeAgentCliVersion.mockReset()
  runtime.resolveRuntimeFileTarget.mockClear()
  await rm(bin, { recursive: true, force: true })
})

describe('structuredAgentSupportsLaunch', () => {
  it('asks nothing for an agent whose location alone decides', async () => {
    expect(await structuredAgentSupportsLaunch('grok', 'id:workspace-1', runtime)).toBe(true)
    expect(probeAgentCliVersion).not.toHaveBeenCalled()
    expect(runtime.resolveRuntimeFileTarget).not.toHaveBeenCalled()
  })

  it('allows stable OpenCode 1.x and 2.x, asking in the workspace with the launch env', async () => {
    for (const [version, supported] of [
      ['1.18.31', true],
      ['2.0.14', true],
      ['2.0.21', true],
      ['1.18.30', false],
      ['2.0.13', false],
      ['2.1.0-beta.1', false],
      ['3.0.0', false]
    ] as const) {
      installedVersion(version)
      expect(await structuredAgentSupportsLaunch('opencode', 'id:workspace-1', runtime)).toBe(
        supported
      )
    }
    expect(asked[0]).toMatchObject({
      cwd: '/repo/worktree',
      env: { PATH: bin, OPENCODE_EXTRA: '1', OPENCODE_CLIENT: 'acp' }
    })
  })

  it('refuses when the version cannot be read', async () => {
    probeAgentCliVersion.mockResolvedValue(false)
    expect(await structuredAgentSupportsLaunch('opencode', 'id:workspace-1', runtime)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'asks about the same binary the launch then spawns',
    async () => {
      installedVersion('1.18.31')
      await structuredAgentSupportsLaunch('opencode', 'id:workspace-1', runtime)
      const launch = await createAcpStructuredLaunchResolver(acpLaunchSpecFor('opencode')!, {
        store: {
          getRecord: () => ({
            ...agentSessionRecordFixture(),
            provider: 'opencode',
            providerHandleChain: [],
            accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } }
          })
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
