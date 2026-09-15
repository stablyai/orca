import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexStructuredSessionAdapterDeps } from '../codex/codex-structured-session-adapter'
import type * as CodexAdapterModule from '../codex/codex-structured-session-adapter'
import type { StructuredClaudeRuntimeAdapterDeps } from './structured-claude-runtime-adapter'
import type * as ClaudeAdapterModule from './structured-claude-runtime-adapter'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime,
  waitForStructuredAgentSessionRecovery
} from './structured-agent-session-runtime'

const captured = vi.hoisted(() => ({
  codex: vi.fn<(deps: CodexStructuredSessionAdapterDeps) => void>(),
  claude: vi.fn<(deps: StructuredClaudeRuntimeAdapterDeps) => void>()
}))

vi.mock('../codex/codex-structured-session-adapter', async (importOriginal) => {
  const original = await importOriginal<typeof CodexAdapterModule>()
  return {
    ...original,
    CodexStructuredSessionAdapter: class extends original.CodexStructuredSessionAdapter {
      constructor(deps: CodexStructuredSessionAdapterDeps) {
        super(deps)
        captured.codex(deps)
      }
    }
  }
})

vi.mock('./structured-claude-runtime-adapter', async (importOriginal) => {
  const original = await importOriginal<typeof ClaudeAdapterModule>()
  return {
    createStructuredClaudeRuntimeAdapter: (deps: StructuredClaudeRuntimeAdapterDeps) => {
      captured.claude(deps)
      return original.createStructuredClaudeRuntimeAdapter(deps)
    }
  }
})

const EXIT: StructuredAgentSessionLifecycleEvent = {
  type: 'ended',
  sessionId: 'session-1',
  reason: 'provider crashed',
  cause: 'unexpected-exit',
  fence: 1,
  acquisitionGeneration: 'generation-1'
}

let stateDirectory: string | undefined

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  if (stateDirectory) {
    await rm(stateDirectory, { recursive: true, force: true })
    stateDirectory = undefined
  }
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe.each([
  'codex exit',
  'claude exit',
  'codex late settlement',
  'claude late settlement',
  'journal'
] as const)('%s error reporting', (source) => {
  it.each(['omitted', 'configured', 'throwing'] as const)(
    'reports failures with an %s reporter without poisoning subsequent callbacks',
    async (reporter) => {
      stateDirectory = await mkdtemp(join(import.meta.dirname, '.runtime-errors-'))
      const error = new Error('durable write failed')
      const reportingError = new Error('reporter failed')
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const onError = vi.fn(() => {
        if (reporter === 'throwing') {
          throw reportingError
        }
      })
      const host = await ensureStructuredAgentSessionHost({
        stateDirectory,
        hostId: 'local',
        claimKeyId: 'key-1',
        resolveWorkspacePath: async () => stateDirectory!,
        resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
        resolveEnvironment: async () => ({}),
        ...(reporter === 'omitted' ? {} : { onError })
      })
      vi.spyOn(host, 'handleAdapterEvent').mockRejectedValue(error)
      vi.spyOn(host, 'settleLateDispatch').mockRejectedValue(error)
      const codex = captured.codex.mock.calls[0]?.[0]
      const claude = captured.claude.mock.calls[0]?.[0]
      expect(codex).toBeDefined()
      expect(claude).toBeDefined()
      const scope = source.endsWith('exit')
        ? 'exit'
        : source.endsWith('late settlement')
          ? 'late-settlement'
          : 'journal'
      const label = source.endsWith('exit')
        ? 'exit recovery'
        : source.endsWith('late settlement')
          ? 'late settlement'
          : source

      for (const count of [1, 2]) {
        if (source === 'codex exit') {
          codex?.onEvent?.(EXIT)
        } else if (source === 'claude exit') {
          claude?.onUnexpectedExit(EXIT)
        } else if (source === 'codex late settlement') {
          codex?.onDispatchSettledLate?.({
            sessionId: EXIT.sessionId,
            clientMessageId: 'message-1',
            providerIdentity: {
              provider: 'codex',
              threadId: 'thread-1',
              turnId: 'turn-1',
              ordinal: 0
            }
          })
        } else if (source === 'claude late settlement') {
          claude?.onDispatchSettledLate?.({
            sessionId: EXIT.sessionId,
            clientMessageId: 'message-1',
            providerIdentity: { provider: 'claude', sessionId: 'provider-1', uuid: 'uuid-1' }
          })
        } else {
          host.deps.onEventSinkError?.({ sessionId: EXIT.sessionId, error })
        }
        await waitForStructuredAgentSessionRecovery()
        if (reporter === 'configured') {
          expect(onError).toHaveBeenCalledTimes(count)
          expect(onError).toHaveBeenLastCalledWith({
            scope: `structured-agent-session-${scope}:${EXIT.sessionId}`,
            error
          })
          expect(consoleError).not.toHaveBeenCalled()
        } else {
          expect(consoleError).toHaveBeenCalledTimes(count)
          expect(consoleError).toHaveBeenLastCalledWith(
            reporter === 'omitted'
              ? `[structured-agent-session] ${label} failed:${EXIT.sessionId}`
              : `[structured-agent-session] ${label} error reporting failed`,
            reporter === 'omitted' ? error : reportingError
          )
        }
      }
    }
  )
})
