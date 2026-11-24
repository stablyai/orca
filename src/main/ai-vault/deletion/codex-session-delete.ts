import { join, posix, resolve } from 'node:path'
import type { AiVaultDeleteSessionResult } from '../../../shared/ai-vault/contracts/ai-vault-session-deletion'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { isPathInsideOrEqual } from '../../../shared/file-access/cross-platform-path'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import { configuredAdditionalCodexHomePaths } from '../discovery/ai-vault-scan-roots'
import { listHostCodexRolloutHomes } from '../../codex/history/cleanup/codex-host-rollout-homes'
import { isOpenInCodex } from '../../codex/history/cleanup/codex-rollout-writer-lock'
import { deleteCodexSessionWithCli } from './session-delete-command'

const ROLLOUT_FILE = /^rollout-.+\.jsonl(?:\.zst)?$/i
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLLOUT_THREAD_ID =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i
const WSL_CODEX_HOME_SEGMENTS = [
  ['.codex'],
  ['.local', 'share', 'orca', 'codex-runtime-home', 'home']
] as const

export type CodexHostSessionDeleteArgs = {
  filePath: string
  sessionId?: string
  executionHostId?: ExecutionHostId
  wslHomeDirs: readonly string[]
}

/** Delete a Codex rollout through `codex delete`, in the home that owns this rollout. */
export async function deleteHostCodexSession(
  args: CodexHostSessionDeleteArgs
): Promise<AiVaultDeleteSessionResult> {
  const agent = 'codex' as const
  if (normalizeExecutionHostId(args.executionHostId) !== LOCAL_EXECUTION_HOST_ID) {
    return { outcome: 'rejected', agent, reason: 'non-local-host' }
  }
  const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : ''
  const sessionId = codexThreadIdFromRolloutPath(filePath) ?? args.sessionId?.trim()
  if (!filePath || !sessionId || !SESSION_ID.test(sessionId)) {
    return { outcome: 'rejected', agent, reason: 'invalid-path' }
  }

  const target = await resolveCodexDeleteTarget(filePath, args.wslHomeDirs)
  if (!target) {
    return { outcome: 'rejected', agent, reason: 'path-outside-known-roots' }
  }

  const result = await deleteCodexSessionWithCli({
    homePath: target.homePath,
    sessionId,
    ...(target.wslDistro ? { wslDistro: target.wslDistro } : {})
  })
  if (result.outcome === 'deleted' || result.outcome === 'not-found') {
    return { outcome: 'deleted' }
  }
  // The CLI hides the reason; a writer lock proves the thread is still open somewhere.
  if (!target.wslDistro && (await isOpenInCodex([target.homePath], filePath))) {
    return { outcome: 'rejected', agent, reason: 'session-in-use' }
  }
  console.warn('[ai-vault] Codex session delete failed:', result.error)
  return { outcome: 'failed', agent, error: result.error }
}

/** Reverted rollouts append a rollout id; the thread id is the UUID before it. */
export function codexThreadIdFromRolloutPath(filePath: string): string | null {
  return (filePath.split(/[\\/]/).at(-1) ?? '').match(ROLLOUT_THREAD_ID)?.[1] ?? null
}

async function resolveCodexDeleteTarget(
  filePath: string,
  wslHomeDirs: readonly string[]
): Promise<{ homePath: string; wslDistro?: string } | null> {
  if (!ROLLOUT_FILE.test(filePath.split(/[\\/]/).at(-1) ?? '')) {
    return null
  }
  const wsl = parseWslUncPath(filePath)
  if (wsl) {
    return (
      wslCodexDeleteTarget(wsl.distro, wsl.linuxPath, wslHomeDirs) ??
      additionalWslCodexTarget(wsl.distro, wsl.linuxPath)
    )
  }
  const resolvedPath = resolve(filePath)
  const { homes } = await listHostCodexRolloutHomes({})
  const homePath = codexHomeContainingFile(homes, resolvedPath)
  return homePath ? { homePath } : null
}

function additionalWslCodexTarget(
  distro: string,
  linuxFilePath: string
): { homePath: string; wslDistro: string } | null {
  for (const homePath of configuredAdditionalCodexHomePaths()) {
    const parsed = parseWslUncPath(homePath)
    if (
      parsed?.distro.toLowerCase() === distro.toLowerCase() &&
      isRolloutUnderWslHome(parsed.linuxPath, linuxFilePath)
    ) {
      return { homePath: parsed.linuxPath, wslDistro: distro }
    }
  }
  return null
}

export function wslCodexDeleteTarget(
  distro: string,
  linuxFilePath: string,
  wslHomeDirs: readonly string[]
): { homePath: string; wslDistro: string } | null {
  for (const homeDir of wslHomeDirs) {
    const parsed = parseWslUncPath(homeDir)
    if (!parsed || parsed.distro.toLowerCase() !== distro.toLowerCase()) {
      continue
    }
    for (const segments of WSL_CODEX_HOME_SEGMENTS) {
      const homePath = posix.join(parsed.linuxPath, ...segments)
      if (isRolloutUnderWslHome(homePath, linuxFilePath)) {
        return { homePath, wslDistro: distro }
      }
    }
  }
  return null
}

/** The Codex home whose sessions or archived_sessions folder owns this rollout, if any. */
export function codexHomeContainingFile(homes: readonly string[], filePath: string): string | null {
  return homes.find((homePath) => isRolloutUnderNativeHome(homePath, filePath)) ?? null
}

function isRolloutUnderNativeHome(homePath: string, filePath: string): boolean {
  return ['sessions', 'archived_sessions'].some((dir) =>
    isPathInsideOrEqual(join(homePath, dir), filePath)
  )
}

function isRolloutUnderWslHome(homePath: string, filePath: string): boolean {
  return ['sessions', 'archived_sessions'].some((dir) =>
    isPathInsideOrEqual(posix.join(homePath, dir), filePath)
  )
}
