// The chat attachment store reaches Claude's launch as an added directory: the runtime hands its
// root to Claude's part of the launch its registration composes. Drop that hand-off and Claude asks
// before reading every attached document.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as LaunchResolution from '../claude/claude-structured-launch-resolution'

type GrantDeps = { attachmentDirectory?: string }

const captured = vi.hoisted(() => {
  const part: GrantDeps[] = []
  return { part }
})

vi.mock('../claude/claude-structured-launch-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof LaunchResolution>()
  return {
    ...actual,
    claudeStructuredLaunchPart: (deps: Parameters<typeof actual.claudeStructuredLaunchPart>[0]) => {
      captured.part.push(deps)
      return actual.claudeStructuredLaunchPart(deps)
    }
  }
})

import { agentSessionAttachmentStoreRoot } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

let stateDirectory: string | null = null

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  if (stateDirectory) {
    await rm(stateDirectory, { recursive: true, force: true })
    stateDirectory = null
  }
})

describe("structured Claude's read grant for chat attachments", () => {
  it("hands the store root from the runtime to Claude's part of the launch", async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'orca-attachment-grant-'))
    const directory = stateDirectory
    await ensureStructuredAgentSessionHost({
      logger: createStructuredAgentSessionLogger(),
      stateDirectory: directory,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => directory,
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveLaunchArgs: () => [],
      resolveEnvironment: async () => ({})
    })

    const root = agentSessionAttachmentStoreRoot(directory)
    expect(captured.part.at(-1)?.attachmentDirectory).toBe(root)
  })
})
