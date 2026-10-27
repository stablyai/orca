import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import { defineMethod, type RpcContext } from '../core'
const MAX_SESSION_ROWS = 256
const MAX_SESSION_SCAN = 1_024
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024

let executableIdentityPromise: Promise<{
  name: string
  sha256: string
}> | null = null

function boundedExecutableIdentity(): Promise<{
  name: string
  sha256: string
}> {
  executableIdentityPromise ??= (async () => {
    const path = await realpath(process.execPath)
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_EXECUTABLE_BYTES) {
      throw new Error('observer_executable_identity_unavailable')
    }
    const bytes = await readFile(path)
    return {
      name: basename(path),
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  })()
  return executableIdentityPromise
}

async function requireCurrentObserver(context: RpcContext) {
  const observer = context.observer
  if (!observer) {
    throw new Error('observer_context_required')
  }
  let current
  try {
    current = await context.runtime.showManagedWorktree(observer.worktreeId)
  } catch {
    throw new Error('observer_scope_stale')
  }
  if (current.id !== observer.worktreeId || current.instanceId !== observer.worktreeInstanceId) {
    throw new Error('observer_scope_stale')
  }
  return observer
}

function boundedRows(context: RpcContext, worktreeId: string) {
  return context.runtime.getBoundedAgentProviderSessionRows(
    worktreeId,
    MAX_SESSION_SCAN,
    MAX_SESSION_ROWS
  )
}

function observerSessionRef(credentialId: string, paneKey: string): string {
  return createHash('sha256')
    .update('orca-observer-session-v1\0')
    .update(credentialId)
    .update('\0')
    .update(paneKey)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Server-owned observer inventory for https://github.com/stablyai/orca/issues/31308.
 * Keep this projection explicit: never return raw runtime, repository, terminal, path, or credential rows.
 */
export const OBSERVER_METHODS = [
  defineMethod({
    name: 'observer.runtime.get',
    permission: 'observer-read',
    params: null,
    handler: async (_params, context) => {
      const observer = await requireCurrentObserver(context)
      const status = context.runtime.getStatus()
      const observed = boundedRows(context, observer.worktreeId)
      return {
        observedAt: Date.now(),
        credentialExpiresAt: observer.expiresAt,
        scope: { worktreeInstanceId: observer.worktreeInstanceId },
        runtime: {
          runtimeId: status.runtimeId,
          runtimeProtocolVersion: status.runtimeProtocolVersion,
          minCompatibleRuntimeClientVersion: status.minCompatibleRuntimeClientVersion,
          graphStatus: status.graphStatus,
          hostPlatform: status.hostPlatform
        },
        agentLogin: observed.rows.some((row) => row.providerSession !== undefined),
        observationsTruncated: observed.truncated,
        executable: await boundedExecutableIdentity()
      }
    }
  }),
  defineMethod({
    name: 'observer.sessions.list',
    permission: 'observer-read',
    params: null,
    handler: async (_params, context) => {
      const observer = await requireCurrentObserver(context)
      const observed = boundedRows(context, observer.worktreeId)
      const sessions = observed.rows
        .map((row) => ({
          // Credential-scoped opaque reference: no pane/tab/terminal/run/provider identifiers cross this boundary.
          sessionRef: observerSessionRef(observer.credentialId, row.paneKey),
          receivedAt: row.receivedAt,
          evidenceObservedAt: row.evidenceObservedAt,
          stateStartedAt: row.stateStartedAt,
          turnStartedAt: row.turnStartedAt,
          turnEndedAt: row.turnEndedAt,
          turnEndDisposition: row.turnEndDisposition,
          providerSessionPresent: row.providerSession !== undefined,
          structuredHostPresent: row.structuredHost !== undefined
        }))
        .sort((left, right) =>
          left.receivedAt === right.receivedAt
            ? left.sessionRef.localeCompare(right.sessionRef)
            : left.receivedAt - right.receivedAt
        )
      return {
        observedAt: Date.now(),
        credentialExpiresAt: observer.expiresAt,
        scope: { worktreeInstanceId: observer.worktreeInstanceId },
        truncated: observed.truncated,
        sessions
      }
    }
  })
]
