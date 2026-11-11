import { createHash, randomUUID } from 'node:crypto'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { resolve } from 'node:path'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { agentSessionPinnedLaunchDirectory } from '../../../runtime/agent-session/records/agent-session-record-launch-directory'
import {
  resolveCodexHomeProcessLockKey,
  withCodexHomeProcessLock
} from '../../../codex-cli/codex-home-process-lock'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import {
  runCodexProviderAppServer,
  type CodexProviderInvocationDeps
} from './codex-provider-session-rename'
import type { CodexSession } from './codex-structured-session-state'
import { reviewCodexHooks } from './codex-hook-review'

export function reviewCodexSessionHooks(
  sessions: Map<string, CodexSession>,
  readInvocation: () => CodexProviderInvocationDeps | undefined
): NonNullable<StructuredAgentSessionAdapter['reviewHooks']> {
  const instance = randomUUID()
  return async (record, trust, signal) => {
    const home = requireLegacyAgentSessionAccountHome(record.accountHome).path
    const operation = withCodexHomeProcessLock(resolveCodexHomeProcessLockKey(home), async () => {
      signal.throwIfAborted()
      const live = sessions.get(record.sessionId)
      const makeScope = (cwd: string, generation?: string) =>
        createHash('sha256')
          .update(
            JSON.stringify([
              instance,
              record.sessionId,
              normalizeRuntimePathForComparison(home),
              normalizeRuntimePathForComparison(cwd),
              generation ?? null
            ])
          )
          .digest('hex')
      if (
        live &&
        !live.ended &&
        !live.connection.closed &&
        live.codexHome &&
        normalizeRuntimePathForComparison(live.codexHome) ===
          normalizeRuntimePathForComparison(home) &&
        live.permissions?.cwd
      ) {
        return reviewCodexHooks(
          (method, params, options) => live.connection.request(method, params, options),
          { threadId: live.threadId },
          makeScope(live.permissions.cwd, live.acquisitionGeneration),
          true,
          trust,
          () => {
            signal.throwIfAborted()
            if (sessions.get(record.sessionId) !== live || live.ended || live.connection.closed) {
              throw new Error('The chat changed. Refresh and review the hook again.')
            }
          }
        )
      }
      const invocation = readInvocation()
      if (!invocation) {
        throw new Error('Codex hook review is not configured')
      }
      const expectedCwd = resolve(
        agentSessionPinnedLaunchDirectory(record) ??
          (await invocation.resolveWorkspacePath(record.location.workspaceId))
      )
      return runCodexProviderAppServer(
        record,
        invocation,
        { timeoutMs: 35_000, signal, experimentalApi: true },
        (rpc, cwd) => {
          if (
            normalizeRuntimePathForComparison(cwd) !==
            normalizeRuntimePathForComparison(expectedCwd)
          ) {
            throw new Error('The chat workspace is unavailable. Restore it before reviewing hooks.')
          }
          return reviewCodexHooks(
            rpc.request,
            { cwds: [cwd] },
            makeScope(cwd),
            false,
            trust,
            () => {
              signal.throwIfAborted()
              if (sessions.get(record.sessionId) !== live) {
                throw new Error('The chat started. Refresh and review the hook again.')
              }
            }
          )
        }
      )
    })
    return waitForPromiseWithSignal(operation, signal)
  }
}
