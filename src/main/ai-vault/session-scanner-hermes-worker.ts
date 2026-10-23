import type { AiVaultSession } from '../../shared/ai-vault-types'
import { shouldCaptureFullFirstUserPrompt } from './session-scanner-first-user-prompt'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { aiVaultScopePathsForWslDistro } from '../../shared/ai-vault-scope-cwd-match'
import { getSharedSqliteReaderClient } from './session-scanner-opencode-sqlite-worker-spawn'
import { openCodeWslClient, openCodeWslPath } from './session-scanner-opencode-wsl-client'
import type { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'
import { runOpenCodeSqliteScanRequest } from './session-scanner-opencode-sqlite-scan-scope'
import {
  splitHermesSqliteCandidate,
  buildHermesSqliteCandidatePath
} from './session-scanner-hermes-sqlite-paths'
import type { TranscriptMessageSink } from './session-transcript-consumers'

export async function listHermesSqliteSessionsViaWorker(
  args: Omit<Parameters<OpenCodeSqliteWorkerClient['list']>[0], 'agent'>
) {
  const dbPath = args.dbPaths[0]
  if (!dbPath) {
    return []
  }
  const wsl = openCodeWslPath(dbPath)
  if (!wsl) {
    return getSharedSqliteReaderClient().list({ ...args, agent: 'hermes' })
  }
  try {
    const scopePaths = args.scopePaths?.length
      ? aiVaultScopePathsForWslDistro(args.scopePaths, wsl.distro)
      : args.scopePaths
    if (args.scopePaths?.length && scopePaths?.length === 0) {
      return []
    }
    const candidates = await runOpenCodeSqliteScanRequest(
      args.signal,
      async (signal) => {
        const client = await openCodeWslClient(wsl.distro, dbPath, signal)
        return client.list({
          ...args,
          dbPaths: [wsl.linuxPath],
          scopePaths,
          signal,
          agent: 'hermes'
        })
      },
      'hermes'
    )
    return candidates.flatMap((candidate) => {
      const parsed = splitHermesSqliteCandidate(candidate.file.path)
      return parsed
        ? [
            {
              ...candidate,
              file: {
                ...candidate.file,
                path: buildHermesSqliteCandidatePath(dbPath, parsed.sessionId)
              }
            }
          ]
        : []
    })
  } catch (error) {
    throwIfSignalAborted(args.signal)
    args.issues.push({
      agent: 'hermes',
      kind: 'scope',
      path: dbPath,
      message: error instanceof Error ? error.message : String(error)
    })
    return []
  }
}

function mapSession(session: AiVaultSession | null, dbPath: string): AiVaultSession | null {
  if (!session) {
    return null
  }
  const filePath = buildHermesSqliteCandidatePath(dbPath, session.sessionId)
  return {
    ...session,
    filePath,
    id: `${session.executionHostId}:hermes:${session.sessionId}:${filePath}`,
    executionHostPlatform: 'linux'
  }
}

export async function readHermesSqliteSessionViaWorker(
  args: { dbPath: string; sessionId: string; platform: NodeJS.Platform; signal?: AbortSignal },
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  return runOpenCodeSqliteScanRequest(
    args.signal,
    async (signal) => {
      const wsl = openCodeWslPath(args.dbPath)
      const client = wsl
        ? await openCodeWslClient(wsl.distro, args.dbPath, signal)
        : getSharedSqliteReaderClient()
      const request = {
        ...args,
        dbPath: wsl?.linuxPath ?? args.dbPath,
        platform: wsl ? ('linux' as const) : args.platform,
        signal,
        agent: 'hermes' as const
      }
      if (!messages?.active) {
        const session = await client.parse({
          ...request,
          fullFirstUserPrompt: shouldCaptureFullFirstUserPrompt()
        })
        return wsl ? mapSession(session, args.dbPath) : session
      }
      const capture = await client.capture(request)
      for (const message of capture.messages) {
        throwIfSignalAborted(signal)
        messages.push(message)
      }
      return wsl ? mapSession(capture.session, args.dbPath) : capture.session
    },
    'hermes'
  )
}
