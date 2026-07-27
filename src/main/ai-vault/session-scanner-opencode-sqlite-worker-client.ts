import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { OpenCodeSqliteListValue } from './session-scanner-opencode-sqlite-worker-protocol'
import type { SessionFileCandidate } from './session-scanner-types'
import {
  LIST_TIMEOUT_MS,
  OpenCodeSqliteWorkerDispatcher,
  OpenCodeSqliteWorkerUnavailableError,
  PARSE_TIMEOUT_MS,
  type WorkerFactory
} from './session-scanner-opencode-sqlite-worker-dispatcher'

export {
  IDLE_TEARDOWN_MS,
  LIST_TIMEOUT_MS,
  MAX_CONSECUTIVE_DEATHS,
  PARSE_TIMEOUT_MS,
  type WorkerFactory
} from './session-scanner-opencode-sqlite-worker-dispatcher'

export class OpenCodeSqliteWorkerClient {
  private readonly dispatcher: OpenCodeSqliteWorkerDispatcher

  constructor(options: { workerFactory: WorkerFactory; log?: (message: string) => void }) {
    this.dispatcher = new OpenCodeSqliteWorkerDispatcher(options.workerFactory, options.log)
  }

  list(args: {
    dbPaths: readonly string[]
    limit: number
    issues: AiVaultScanIssue[]
  }): Promise<SessionFileCandidate[]> {
    return this.listFor('opencode', args)
  }

  listHermes(args: {
    dbPaths: readonly string[]
    limit?: number
    issues: AiVaultScanIssue[]
    profileNames?: readonly (string | null)[]
  }): Promise<SessionFileCandidate[]> {
    return this.listFor('hermes', args)
  }

  parse(args: {
    dbPath: string
    sessionId: string
    platform: NodeJS.Platform
  }): Promise<AiVaultSession | null> {
    return this.parseFor('opencode', args)
  }

  parseHermes(args: {
    dbPath: string
    sessionId: string
    platform: NodeJS.Platform
    profileName?: string | null
  }): Promise<AiVaultSession | null> {
    return this.parseFor('hermes', args)
  }

  private async listFor(
    source: 'opencode' | 'hermes',
    args: {
      dbPaths: readonly string[]
      limit?: number
      issues: AiVaultScanIssue[]
      profileNames?: readonly (string | null)[]
    }
  ): Promise<SessionFileCandidate[]> {
    if (args.dbPaths.length === 0) {
      return []
    }
    try {
      const request =
        source === 'hermes'
          ? {
              kind: 'list' as const,
              source,
              dbPaths: args.dbPaths,
              limit: args.limit,
              profileNames: args.profileNames
            }
          : { kind: 'list' as const, dbPaths: args.dbPaths, limit: args.limit ?? 0 }
      const value = (await this.dispatcher.dispatch(
        request,
        LIST_TIMEOUT_MS
      )) as OpenCodeSqliteListValue
      args.issues.push(...value.issues)
      return value.candidates
    } catch (err) {
      if (err instanceof OpenCodeSqliteWorkerUnavailableError && source === 'opencode') {
        args.issues.push({
          agent: source,
          path: args.dbPaths[0] ?? 'opencode.db',
          message:
            'OpenCode history was skipped because its background scanner could not start; the app remains responsive.'
        })
      } else {
        args.issues.push({
          agent: source,
          path: args.dbPaths[0] ?? (source === 'hermes' ? 'state.db' : 'opencode.db'),
          message: `${source === 'hermes' ? 'Hermes' : 'OpenCode'} history scan did not complete: ${
            err instanceof Error ? err.message : String(err)
          }`
        })
      }
      return []
    }
  }

  private async parseFor(
    source: 'opencode' | 'hermes',
    args: {
      dbPath: string
      sessionId: string
      platform: NodeJS.Platform
      profileName?: string | null
    }
  ): Promise<AiVaultSession | null> {
    try {
      const request =
        source === 'hermes'
          ? { kind: 'parse' as const, source, ...args }
          : {
              kind: 'parse' as const,
              dbPath: args.dbPath,
              sessionId: args.sessionId,
              platform: args.platform
            }
      return (await this.dispatcher.dispatch(request, PARSE_TIMEOUT_MS)) as AiVaultSession | null
    } catch (err) {
      if (err instanceof OpenCodeSqliteWorkerUnavailableError) {
        throw new Error(
          `${source === 'hermes' ? 'Hermes' : 'OpenCode'} SQLite background scanner could not start.`
        )
      }
      throw err instanceof Error ? err : new Error(String(err))
    }
  }
}
