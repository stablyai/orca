import { expect, it, vi } from 'vitest'
import type { AgentCliVersionInput } from '../../../agent-launch/preflight/agent-cli-version-probe'

const { versions, standIn } = vi.hoisted(() => ({
  versions: new Map<string, string>(),
  standIn: vi.fn<(command: string) => string | null>()
}))

vi.mock('../../../agent-launch/preflight/agent-cli-version-probe', () => ({
  launchableRelease: (check: { status: string }) =>
    check.status === 'ready' || check.status === 'unknown',
  checkAgentCliVersion: async (input: AgentCliVersionInput) => {
    const version = versions.get(input.program) ?? null
    return version === '1.5.4'
      ? { status: 'tooOld', version, minimumVersion: '1.5.5' }
      : { status: 'ready', version }
  }
}))

vi.mock('../environment/structured-agent-shell-environment', () => ({
  resolveHostAgentBaseEnvironment: async () => ({}),
  refreshHostAgentBaseEnvironmentAfterMiss: undefined,
  createStructuredAgentEnvironmentResolvers: vi.fn()
}))

vi.mock('../installation/structured-agent-runtime-metadata', () => ({
  structuredAgentRuntimeMetadata: () => ({
    launchCheck: {
      resolveLaunch: (env: Record<string, string>) => ({
        command: '/usr/local/bin/agy',
        prefixArgs: [],
        env
      }),
      minimumVersions: ['1.5.5'],
      standIn
    }
  })
}))

import { observeStructuredAgentLaunch } from './structured-agent-launch-support'

const runtime = {
  requireStore: () => ({
    getSettings: () => ({
      agentDefaultEnv: {},
      nativeChatInheritShellEnvironment: false,
      nativeChatShellEnvironmentVariables: [],
      httpProxyUrl: '',
      httpProxyBypassRules: ''
    })
  })
}
const observe = () =>
  observeStructuredAgentLaunch('antigravity', async () => '/work', runtime, false)

it("admits a too-old own agy when Orca's copy would run the chat instead", async () => {
  versions.set('/usr/local/bin/agy', '1.5.4')
  versions.set('/orca/agy', '1.5.13')
  standIn.mockReturnValue('/orca/agy')
  await expect(observe()).resolves.toEqual({ status: 'ready', version: '1.5.13' })
})

it('keeps the too-old answer when no copy may stand in', async () => {
  versions.set('/usr/local/bin/agy', '1.5.4')
  standIn.mockReturnValue(null)
  await expect(observe()).resolves.toEqual({
    status: 'tooOld',
    version: '1.5.4',
    minimumVersion: '1.5.5'
  })
})
