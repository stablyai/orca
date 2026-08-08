import { lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { AI_VAULT_SCOPE_PATHS_MAX_COUNT, type AiVaultListResult } from '../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import {
  SSH_AI_VAULT_LIST_LIMIT_MAX,
  SSH_AI_VAULT_LIST_SESSIONS_METHOD,
  SSH_AI_VAULT_SCOPE_PATH_MAX_LENGTH,
  type SshAiVaultRelayListParams
} from '../shared/ssh-ai-vault-relay'
import { scanRemoteAiVaultSessions } from '../main/ai-vault/remote-session-scanner'
import type { RemoteSessionFilesystemProvider } from '../main/ai-vault/remote-session-scanner-types'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import { parseUnameToRelayPlatform } from '../main/ssh/relay-protocol'
import { readRelayFileContent } from './fs-handler-file-read'
import { relayLogLine } from './relay-diagnostic-log'
import type { RelayDispatcher } from './dispatcher'
import { AiVaultScanCoordinator } from '../main/ai-vault/ai-vault-scan-coordinator'

type ScanRemoteSessions = typeof scanRemoteAiVaultSessions

type AiVaultHandlerOptions = {
  remoteHome?: string
  hostPlatform?: RemoteHostPlatform
  scanRemoteSessions?: ScanRemoteSessions
}

export class AiVaultHandler {
  private readonly remoteHome: string
  private readonly scanRemoteSessions: ScanRemoteSessions
  private readonly provider: RemoteSessionFilesystemProvider
  private readonly scanCoordinator = new AiVaultScanCoordinator()

  constructor(dispatcher: RelayDispatcher, options: AiVaultHandlerOptions = {}) {
    this.remoteHome = options.remoteHome ?? homedir()
    this.scanRemoteSessions = options.scanRemoteSessions ?? scanRemoteAiVaultSessions
    this.provider = createRelayAiVaultFilesystemProvider()
    const hostPlatform = options.hostPlatform ?? currentRelayHostPlatform()
    // Why: an OS/arch this build has no path flavor for must not abort relay
    // startup — leaving the method unregistered soft-disables the feature and
    // the host falls back to its own SSH filesystem scan.
    if (!hostPlatform) {
      relayLogLine(
        `[relay] Agent Session History disabled: unsupported platform ${process.platform}-${process.arch}`
      )
      return
    }
    dispatcher.onRequest(SSH_AI_VAULT_LIST_SESSIONS_METHOD, (params, context) =>
      this.listSessions(hostPlatform, params, context.signal)
    )
  }

  private async listSessions(
    hostPlatform: RemoteHostPlatform,
    rawParams: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<AiVaultListResult> {
    const params = normalizeSshAiVaultRelayListParams(rawParams)
    const result = await this.scanCoordinator.run({
      key: JSON.stringify({
        limit: params.limit,
        unlimited: params.unlimited,
        scopePaths: params.scopePaths,
        scopePathsTruncated: params.scopePathsTruncated
      }),
      force: params.force,
      signal,
      start: (scanSignal) =>
        this.scanRemoteSessions({
          provider: this.provider,
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          remoteHome: this.remoteHome,
          hostPlatform,
          limit: params.limit,
          unlimited: params.unlimited,
          scopePaths: params.scopePaths,
          signal: scanSignal
        })
    })
    if (!params.scopePathsTruncated) {
      return result
    }
    return {
      ...result,
      issues: [
        ...result.issues,
        {
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          agent: 'codex',
          kind: 'scope',
          path: this.remoteHome,
          message: `Only the first ${AI_VAULT_SCOPE_PATHS_MAX_COUNT} project paths were scanned.`
        }
      ]
    }
  }
}

export function normalizeSshAiVaultRelayListParams(
  params: Record<string, unknown>
): SshAiVaultRelayListParams {
  const rawLimit = params.limit
  const unlimited = params.unlimited === true
  const limit =
    !unlimited && typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), SSH_AI_VAULT_LIST_LIMIT_MAX)
      : undefined
  const scopePaths = Array.isArray(params.scopePaths)
    ? params.scopePaths
        .slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT)
        .filter(
          (path): path is string =>
            typeof path === 'string' &&
            path.trim().length > 0 &&
            path.length <= SSH_AI_VAULT_SCOPE_PATH_MAX_LENGTH
        )
    : undefined
  const scopePathsTruncated =
    params.scopePathsTruncated === true ||
    (Array.isArray(params.scopePaths) && params.scopePaths.length > AI_VAULT_SCOPE_PATHS_MAX_COUNT)
  return {
    ...(unlimited ? { unlimited: true } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(params.force === true ? { force: true } : {}),
    ...(scopePaths === undefined ? {} : { scopePaths }),
    ...(scopePathsTruncated ? { scopePathsTruncated: true } : {})
  }
}

function currentRelayHostPlatform(): RemoteHostPlatform | null {
  const relayPlatform = parseUnameToRelayPlatform(process.platform, process.arch)
  return relayPlatform ? getRemoteHostPlatform(relayPlatform) : null
}

function createRelayAiVaultFilesystemProvider(): RemoteSessionFilesystemProvider {
  return {
    async readDir(dirPath) {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink()
      }))
    },
    readFile: readRelayFileContent,
    async stat(filePath) {
      const stats = await lstat(filePath)
      return {
        size: stats.size,
        type: stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file',
        mtime: stats.mtimeMs,
        mtimeMs: stats.mtimeMs,
        dev: stats.dev,
        ino: stats.ino,
        nlink: stats.nlink
      }
    }
  }
}
