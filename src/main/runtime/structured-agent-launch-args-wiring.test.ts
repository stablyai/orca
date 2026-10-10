import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime,
  STRUCTURED_AGENT_LAUNCH_ARGS_REQUIRED
} from './structured-agent-session-runtime'
import { SCRIPTED_CODEX_INSTALLATION_REQUIRED } from './structured-agent-runtime-registrations'

let stateDirectory: string | undefined

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  if (stateDirectory) {
    await rm(stateDirectory, { recursive: true, force: true })
    stateDirectory = undefined
  }
})

it('refuses installation when the host omits the saved Arguments source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-launch-args-wiring-'))
  stateDirectory = root

  await expect(
    // @ts-expect-error Exercise an unchecked caller that dropped the required resolver.
    ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      logger: createStructuredAgentSessionLogger()
    })
  ).rejects.toThrow(STRUCTURED_AGENT_LAUNCH_ARGS_REQUIRED)
})

it('refuses a scripted Codex transport that does not say which Codex it stands for', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-launch-args-wiring-'))
  stateDirectory = root

  // Without it the version check would run whatever real codex is on this machine's PATH.
  await expect(
    ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      openCodexConnection: async () => {
        throw new Error('never opened')
      },
      logger: createStructuredAgentSessionLogger()
    })
  ).rejects.toThrow(SCRIPTED_CODEX_INSTALLATION_REQUIRED)
})
