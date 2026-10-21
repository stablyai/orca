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
