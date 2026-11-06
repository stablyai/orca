import { basename, dirname, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { readCodexRolloutSessionMeta } from '../../../codex/history/rollouts/codex-rollout-session-meta'
import { forEachSessionFile } from '../../session-scanner-discovery'
import {
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName
} from '../../session-scanner-accumulator'
import { readCodexNonUserOrigin } from './session-scanner-codex-non-user-origin'
import { asRecord, extractString } from '../../session-scanner-values'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import type { AiVaultSubagentListResult } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { recordSessionScanIssue, scanIssueTextFromError } from '../../session-scan-issues'

const sessionMeta = async (path: string) =>
  asRecord((await readCodexRolloutSessionMeta(path, undefined, 'scan'))?.payload)

type ChildIdentity = {
  id: string | null
  cwd: string | null
  origin: ReturnType<typeof readCodexNonUserOrigin>
}
// session_meta is a rollout's immutable first record, so each file is read once per service.
const identities = new Map<string, ChildIdentity>()
const MAX_CACHED_IDENTITIES = 10_000

async function childIdentity(path: string): Promise<ChildIdentity | null> {
  const cached = identities.get(path)
  if (cached) {
    identities.delete(path)
    identities.set(path, cached)
    return cached
  }
  const meta = await sessionMeta(path)
  if (!meta) {
    return null
  }
  const identity = {
    id: extractString(meta.id),
    cwd: extractString(meta.cwd),
    origin: readCodexNonUserOrigin(meta)
  }
  identities.set(path, identity)
  if (identities.size > MAX_CACHED_IDENTITIES) {
    identities.delete(identities.keys().next().value!)
  }
  return identity
}

const rolloutDay = (path: string): string | undefined =>
  /^rollout-(\d{4}-\d{2}-\d{2})T/.exec(basename(path))?.[1]

/** Discover identities only; opening looks the child up in the live parent's `/subagents` picker. */
export async function listCodexChildSessions(args: {
  parentFilePath: string
  sessionsRoot: string
}): Promise<AiVaultSubagentListResult> {
  const result: AiVaultSubagentListResult = { sessions: [], issues: [] }
  try {
    const root = await realpath(args.sessionsRoot)
    const parentPath = await realpath(args.parentFilePath)
    if (!isPathInsideOrEqual(root, parentPath)) {
      return result
    }
    const parent = await sessionMeta(parentPath)
    const parentId = extractString(parent?.id)
    if (!parentId || parentId !== sessionIdFromFileName(parentPath)) {
      return result
    }
    const parentDay = rolloutDay(parentPath)
    const parentYear = parentDay?.slice(0, 4)
    await forEachSessionFile(
      root,
      'codex',
      result.issues,
      {
        // One unreadable day directory must not mark every parent's child list as failed.
        extensions: new Set(['.jsonl']),
        // A child is spawned after its parent starts, so earlier rollouts cannot be its children.
        directoryPredicate: (name, depth) =>
          depth !== 0 || !parentYear || !/^\d{4}$/.test(name) || name >= parentYear,
        filePredicate: (path) => {
          const day = rolloutDay(path)
          return !parentDay || !day || day >= parentDay
        }
      },
      async (path) => {
        if (resolve(path) === resolve(parentPath)) {
          return
        }
        // An unrelated unreadable rollout must not hide the parent's readable children.
        const identity = await childIdentity(path).catch(() => null)
        if (!identity) {
          return
        }
        const { id, origin } = identity
        if (
          !id ||
          id === parentId ||
          id !== sessionIdFromFileName(path) ||
          origin?.kind !== 'thread_spawn' ||
          !origin.parentage ||
          origin.parentage.parentThreadId !== parentId
        ) {
          return
        }
        // A rollout pruned mid-walk is skipped like an unreadable one.
        const file = await stat(path).catch(() => null)
        if (!file) {
          return
        }
        const accumulator = createAccumulator({
          agent: 'codex',
          sessionId: id,
          file: { path, mtimeMs: file.mtimeMs, modifiedAt: file.mtime.toISOString() }
        })
        accumulator.cwd = identity.cwd
        accumulator.title = origin.parentage.agentNickname ?? origin.parentage.agentRole ?? id
        const session = finalizeSession(accumulator, process.platform, { codexHome: dirname(root) })
        if (session) {
          result.sessions.push({
            ...session,
            subagent: {
              parentSessionId: parentId,
              agentType: origin.parentage.agentRole,
              status: null
            }
          })
        }
      }
    )
  } catch (error) {
    recordSessionScanIssue(result.issues, {
      agent: 'codex',
      path: args.parentFilePath,
      ...scanIssueTextFromError(error)
    })
  }
  return result
}
