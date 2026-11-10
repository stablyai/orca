import { resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../../../shared/ai-vault/contracts/ai-vault-session-deletion'
import {
  normalizeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import {
  materializeCodexSessionDeletionSymlinks,
  discardCodexSessionDeletionStagingFiles
} from './codex-session-delete-symlinks'
import { resolveCodexCommand } from '../../../codex-cli/command'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-identity'
import { readCodexRolloutSessionMetaId } from '../rollouts/codex-rollout-session-meta'
import {
  assertCodexSessionDeletionPath,
  codexSessionDeletionHomes,
  collectCodexSessionDeletionHomes,
  planCodexSessionDeletionHomes,
  type CodexSessionDeletionSymlink,
  type CodexSessionDeletionStagingFile
} from './codex-session-delete-targets'
import {
  isCodexSessionDeletionRecorded,
  isCodexSessionUuid,
  pendingCodexSessionDeletionHomes,
  recordCodexSessionDeletion,
  withCodexSessionHistoryMutation
} from './codex-session-deletion-record'

type CodexSessionDeleteOptions = {
  homes?: readonly string[]
  run?: typeof runProcess
  command?: string
  canDelete?: (sessionId: string, filePath: string) => Promise<boolean>
}

export async function deleteCodexSession(
  args: AiVaultDeleteSessionArgs,
  options: CodexSessionDeleteOptions = {}
): Promise<AiVaultDeleteSessionResult> {
  if (typeof args.filePath !== 'string') {
    return { outcome: 'rejected', agent: 'codex', reason: 'invalid-path' }
  }
  if (
    normalizeExecutionHostId(args.executionHostId) !== LOCAL_EXECUTION_HOST_ID ||
    isWslUncPath(args.filePath)
  ) {
    return { outcome: 'rejected', agent: 'codex', reason: 'non-local-host' }
  }
  if (!isCodexSessionUuid(args.sessionId)) {
    return { outcome: 'rejected', agent: 'codex', reason: 'invalid-path' }
  }
  const sessionId = args.sessionId.toLowerCase()
  return withCodexSessionHistoryMutation<AiVaultDeleteSessionResult>(sessionId, async () => {
    try {
      const homes = options.homes ?? codexSessionDeletionHomes()
      const path = resolve(args.filePath)
      const remaining = await pendingCodexSessionDeletionHomes(sessionId)
      const home = [...homes, ...remaining].find((candidate) =>
        isPathInsideOrEqual(resolve(candidate), path)
      )
      if (!home || parseCodexRolloutThreadId(path)?.threadId !== sessionId) {
        return { outcome: 'rejected', agent: 'codex', reason: 'path-outside-known-roots' }
      }
      if (await isCodexSessionDeletionRecorded(sessionId, true)) {
        return { outcome: 'deleted' }
      }
      const canDelete =
        options.canDelete ??
        (await import('./codex-session-delete-eligibility')).canDeleteCodexSession
      if (!(await canDelete(sessionId, path))) {
        return failed('active')
      }
      if (!(await isCodexSessionDeletionRecorded(sessionId))) {
        await assertCodexSessionDeletionPath(home, path, homes)
        if ((await readCodexRolloutSessionMetaId(path))?.toLowerCase() !== sessionId) {
          return { outcome: 'rejected', agent: 'codex', reason: 'undiscoverable-path' }
        }
      }
      const filePaths = new Set([args.filePath])
      const stagingFiles: CodexSessionDeletionStagingFile[] = []
      const symlinks: CodexSessionDeletionSymlink[] = []
      const targets = await planCodexSessionDeletionHomes(
        sessionId,
        homes,
        remaining,
        home,
        (file) => filePaths.add(file),
        (alias) => symlinks.push(alias),
        (file) => stagingFiles.push(file)
      )
      const command = options.command ?? resolveCodexCommand()
      const run = options.run ?? runProcess
      if (!(await probeSupport(targets, command, run))) {
        return failed('unsupported')
      }
      if (!(await canDelete(sessionId, path))) {
        return failed('active')
      }
      await recordCodexSessionDeletion(sessionId, false, targets)
      await discardCodexSessionDeletionStagingFiles(stagingFiles)
      await materializeCodexSessionDeletionSymlinks(sessionId, symlinks, homes)
      if (
        !(await runDeletes(targets, sessionId, command, run)) ||
        (await collectCodexSessionDeletionHomes(sessionId, homes)).length > 0
      ) {
        return failed('incomplete')
      }
      await recordCodexSessionDeletion(sessionId, true)
      return { outcome: 'deleted', filePaths: [...filePaths] }
    } catch {
      return unchangedOrIncomplete(sessionId)
    }
  }).catch(() => unchangedOrIncomplete(sessionId))
}

async function probeSupport(
  targets: readonly string[],
  command: string,
  run: typeof runProcess
): Promise<boolean> {
  for (const target of targets) {
    const probe = await run({
      program: command,
      args: ['delete', '--help'],
      cwd: target,
      env: { ...process.env, CODEX_HOME: target },
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024
    }).catch(() => null)
    if (
      !probe ||
      probe.code !== 0 ||
      probe.timedOut ||
      !/Usage:\s+codex delete\b/.test(probe.stdout) ||
      !probe.stdout.includes('--force')
    ) {
      return false
    }
  }
  return true
}

async function runDeletes(
  targets: readonly string[],
  sessionId: string,
  command: string,
  run: typeof runProcess
): Promise<boolean> {
  const remaining = [...targets]
  for (const target of targets) {
    const result = await run({
      program: command,
      args: ['delete', sessionId, '--force'],
      cwd: target,
      env: { ...process.env, CODEX_HOME: target },
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024
    }).catch(() => null)
    if (!result || result.code !== 0 || result.timedOut) {
      return false
    }
    remaining.shift()
    await recordCodexSessionDeletion(sessionId, false, remaining)
  }
  return true
}

function failed(detail: 'active' | 'unsupported' | 'incomplete'): AiVaultDeleteSessionResult {
  return { outcome: 'failed', agent: 'codex', error: `Codex session deletion ${detail}`, detail }
}

async function unchangedOrIncomplete(sessionId: string): Promise<AiVaultDeleteSessionResult> {
  try {
    if (await isCodexSessionDeletionRecorded(sessionId)) {
      return failed('incomplete')
    }
  } catch {}
  return { outcome: 'failed', agent: 'codex', error: 'Codex session deletion could not start' }
}
