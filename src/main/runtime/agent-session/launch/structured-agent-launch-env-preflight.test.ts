import { describe, expect, it, vi } from 'vitest'
import {
  resolveHostStructuredAgentLaunchEnvironment,
  type LaunchEnvironmentSettings
} from './structured-agent-launch-support'
import type * as ShellEnvironment from '../environment/structured-agent-shell-environment'

vi.mock('../environment/structured-agent-shell-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof ShellEnvironment>()),
  resolveHostAgentBaseEnvironment: async () => ({ PATH: 'C:\\old-pi', KEEP: 'kept' })
}))

const settings: LaunchEnvironmentSettings = {
  agentDefaultEnv: { pi: { Path: 'C:\\new-pi' } },
  nativeChatInheritShellEnvironment: true,
  nativeChatShellEnvironmentVariables: []
}

describe('preflight launch environment', () => {
  it('lets a configured Path replace the inherited PATH on Windows', async () => {
    expect(await resolveHostStructuredAgentLaunchEnvironment('pi', settings, 'win32')).toEqual({
      KEEP: 'kept',
      Path: 'C:\\new-pi'
    })
  })
})
