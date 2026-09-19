import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import {
  AI_VAULT_SESSION_RG_MAX_TARGETS,
  AI_VAULT_SESSION_RG_TIMEOUT_MS,
  aiVaultSessionRgTargets,
  buildAiVaultSessionRgArgs,
  parentTranscriptDirectory
} from '../../shared/ai-vault-session-rg-args'
import {
  emptyAiVaultSearchSessionsResult,
  type AiVaultRgSearchScope,
  type AiVaultSearchSessionsArgs,
  type AiVaultSearchSessionsResult
} from '../../shared/ai-vault-session-search-scope'
import { sessionTranscriptIsRemoteOwned } from '../../shared/ai-vault-session-host'
import { transcriptLineMatchesSearchScope } from '../../shared/ai-vault-session-transcript-scope'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { wslAwareSpawn } from '../git/runner'
import { checkRgAvailable } from '../ipc/rg-availability'
import { parseWslPath } from '../wsl'
import { AI_VAULT_SESSION_TRANSCRIPT_MAX_BYTES } from './session-message-transcript-lines'

export async function searchAiVaultSessionsWithRg(
  args: AiVaultSearchSessionsArgs,
  sessionsById: ReadonlyMap<string, AiVaultSession>
): Promise<AiVaultSearchSessionsResult> {
  const query = args.query.trim()
  if (!query) {
    return emptyAiVaultSearchSessionsResult()
  }

  const candidates: AiVaultSession[] = []
  const targets: string[] = []
  const sessionIdsByTarget = new Map<string, Set<string>>()
  let targetsTruncated = false
  for (const sessionId of args.sessionIds) {
    if (targets.length >= AI_VAULT_SESSION_RG_MAX_TARGETS) {
      targetsTruncated = true
      break
    }
    const session = sessionsById.get(sessionId)
    if (!session || sessionTranscriptIsRemoteOwned(session)) {
      continue
    }
    const sessionTargets = aiVaultSessionRgTargets(session)
    if (sessionTargets.length === 0) {
      continue
    }
    candidates.push(session)
    for (const target of sessionTargets) {
      if (targets.length >= AI_VAULT_SESSION_RG_MAX_TARGETS) {
        targetsTruncated = true
        break
      }
      targets.push(target)
      const owners = sessionIdsByTarget.get(target) ?? new Set<string>()
      owners.add(session.id)
      sessionIdsByTarget.set(target, owners)
    }
  }

  if (targets.length === 0) {
    return emptyAiVaultSearchSessionsResult()
  }

  const rgAvailable = await checkRgAvailable(parentTranscriptDirectory(targets[0] ?? '.'))
  if (!rgAvailable) {
    return emptyAiVaultSearchSessionsResult()
  }

  const matchedPaths = await runAiVaultSessionRg(query, uniquePaths(targets))
  if (matchedPaths.failed) {
    return emptyAiVaultSearchSessionsResult()
  }
  const matchedIds = new Set<string>()
  for (const matchedPath of matchedPaths.paths) {
    const owners =
      sessionIdsByTarget.get(matchedPath) ?? sessionIdsByTarget.get(normalizePath(matchedPath))
    if (!owners) {
      for (const [target, ids] of sessionIdsByTarget) {
        if (pathsReferToSameFile(target, matchedPath)) {
          for (const id of ids) {
            matchedIds.add(id)
          }
        }
      }
      continue
    }
    for (const id of owners) {
      matchedIds.add(id)
    }
  }

  if (args.searchScope === 'full') {
    return {
      ...emptyAiVaultSearchSessionsResult(),
      matchedIds: [...matchedIds],
      usedRg: true,
      truncated: matchedPaths.truncated || targetsTruncated
    }
  }

  const scopedIds: string[] = []
  for (const session of candidates) {
    if (!matchedIds.has(session.id)) {
      continue
    }
    if (await sessionMatchesRgScope(session, query, args.searchScope)) {
      scopedIds.push(session.id)
    }
  }
  return {
    ...emptyAiVaultSearchSessionsResult(),
    matchedIds: scopedIds,
    usedRg: true,
    truncated: matchedPaths.truncated || targetsTruncated
  }
}

export async function sessionMatchesRgScope(
  session: Pick<AiVaultSession, 'agent' | 'filePath'>,
  query: string,
  searchScope: AiVaultRgSearchScope
): Promise<boolean> {
  for (const filePath of aiVaultSessionRgTargets(session)) {
    if (await fileMatchesRgScope(filePath, query, searchScope)) {
      return true
    }
  }
  return false
}

async function fileMatchesRgScope(
  filePath: string,
  query: string,
  searchScope: AiVaultRgSearchScope
): Promise<boolean> {
  try {
    if (filePath.endsWith('.json') && !filePath.endsWith('.jsonl')) {
      if ((await stat(filePath)).size > AI_VAULT_SESSION_TRANSCRIPT_MAX_BYTES) {
        return false
      }
      const raw = await readFile(filePath, 'utf-8')
      return transcriptLineMatchesSearchScope(raw, query, searchScope)
    }
    const input = createReadStream(filePath, { encoding: 'utf-8' })
    const lines = createInterface({
      input,
      crlfDelay: Infinity
    })
    try {
      for await (const line of lines) {
        if (transcriptLineMatchesSearchScope(line, query, searchScope)) {
          return true
        }
      }
    } finally {
      lines.close()
      input.destroy()
    }
  } catch {
    return false
  }
  return false
}

type SessionRgSpawnResult = {
  paths: string[]
  truncated: boolean
  failed: boolean
}

async function runAiVaultSessionRg(
  query: string,
  targets: readonly string[]
): Promise<SessionRgSpawnResult> {
  const localTargets = targets.filter((target) => !parseWslPath(target))
  const wslTargets = targets.filter((target) => parseWslPath(target))
  const [local, wsl] = await Promise.all([
    localTargets.length > 0 ? spawnSessionRg(query, localTargets) : emptyRgResult(),
    wslTargets.length > 0 ? spawnSessionRg(query, wslTargets) : emptyRgResult()
  ])
  return {
    paths: [...local.paths, ...wsl.paths],
    truncated: local.truncated || wsl.truncated,
    failed: local.failed || wsl.failed
  }
}

function emptyRgResult(): Promise<SessionRgSpawnResult> {
  return Promise.resolve({ paths: [], truncated: false, failed: false })
}

function spawnSessionRg(query: string, targets: readonly string[]): Promise<SessionRgSpawnResult> {
  return new Promise((resolve) => {
    const cwd = parentTranscriptDirectory(targets[0] ?? '.')
    const child = wslAwareSpawn('rg', buildAiVaultSessionRgArgs(query, targets), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let settled = false
    const timeout = setTimeout(() => {
      child.kill()
      finish(true, false)
    }, AI_VAULT_SESSION_RG_TIMEOUT_MS)

    const finish = (truncated: boolean, failed: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      child.stdout?.off('data', onData)
      child.off('error', onError)
      child.off('close', onCloseCode)
      const paths = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      resolve({ paths, truncated, failed })
    }

    const onData = (chunk: string): void => {
      stdout += chunk
    }
    const onError = (): void => finish(false, true)
    // rg: 0 = matches, 1 = no matches, >=2 = error
    const onCloseCode = (code: number | null): void => finish(false, (code ?? 2) >= 2)

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', onData)
    child.stderr?.resume()
    child.once('error', onError)
    child.once('close', onCloseCode)
  })
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function pathsReferToSameFile(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right) || left === right
}
