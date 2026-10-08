// The chat attachment store reaches Claude's launch as an added directory: the runtime hands its
// root to the Claude adapter, and the adapter to the launch resolver. Drop either hand-off and
// Claude asks before reading every attached document.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as LaunchResolution from '../claude/claude-structured-launch-resolution'
import type * as ClaudeRuntimeAdapter from './structured-claude-runtime-adapter'

type GrantDeps = { attachmentDirectory?: string }

const captured = vi.hoisted(() => {
  const adapter: GrantDeps[] = []
  const resolver: GrantDeps[] = []
  return { adapter, resolver }
})

vi.mock('./structured-claude-runtime-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeRuntimeAdapter>()
  return {
    ...actual,
    createStructuredClaudeRuntimeAdapter: (
      deps: Parameters<typeof actual.createStructuredClaudeRuntimeAdapter>[0]
    ) => {
      captured.adapter.push(deps)
      return actual.createStructuredClaudeRuntimeAdapter(deps)
    }
  }
})

vi.mock('../claude/claude-structured-launch-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof LaunchResolution>()
  return {
    ...actual,
    createClaudeStructuredLaunchResolver: (
      deps: Parameters<typeof actual.createClaudeStructuredLaunchResolver>[0]
    ) => {
      captured.resolver.push(deps)
      return actual.createClaudeStructuredLaunchResolver(deps)
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
  it('hands the store root from the runtime through the adapter to the launch resolver', async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'orca-attachment-grant-'))
    const directory = stateDirectory
    await ensureStructuredAgentSessionHost({
      logger: createStructuredAgentSessionLogger(),
      stateDirectory: directory,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => directory,
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveLaunchArgs: () => [],
      resolveEnvironment: async () => ({})
    })

    const root = agentSessionAttachmentStoreRoot(directory)
    expect(captured.adapter.at(-1)?.attachmentDirectory).toBe(root)
    expect(captured.resolver.at(-1)?.attachmentDirectory).toBe(root)
  })
})
