import type { AiVaultSession } from '../../shared/ai-vault-types'
import { waitForPromiseWithSignal, throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { admitWslTranscriptPath } from '../native-chat/wsl-transcript-running-admission'
import { noteWslDistroMayHaveStopped } from '../wsl/wsl-unc-access-gate'
import { createOpenCodeSqliteProcessClient } from './session-scanner-opencode-sqlite-process-client'
import type { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'
import type { OpenCodeWslRuntime } from './session-scanner-opencode-wsl-runtime'
import { buildRelayAiVaultServiceEnv } from './session-scanner-service-env'
import { AiVaultScanIssueError } from './session-scan-issues'
import {
  AI_VAULT_SCAN_ISSUE_COPY,
  aiVaultScanIssueText
} from '../../shared/ai-vault-scan-issue-copy'

const runtimes = new Map<string, OpenCodeWslRuntime>()
const clients = new Map<string, OpenCodeSqliteWorkerClient>()

export function configureOpenCodeWslReaders(entries: readonly OpenCodeWslRuntime[]): void {
  const present = new Set(entries.map((entry) => entry.distro.toLowerCase()))
  for (const key of runtimes.keys()) {
    if (!present.has(key)) {
      clients.get(key)?.dispose()
      clients.delete(key)
      runtimes.delete(key)
    }
  }
  for (const entry of entries) {
    const key = entry.distro.toLowerCase()
    const previous = runtimes.get(key)
    if (
      previous?.executable !== entry.executable ||
      previous?.readerPath !== entry.readerPath ||
      previous?.error !== entry.error
    ) {
      clients.get(key)?.dispose()
      clients.delete(key)
      runtimes.set(key, entry)
    }
  }
}

export function openCodeWslPath(path: string): ReturnType<typeof parseWslUncPath> {
  return process.platform === 'win32' ? parseWslUncPath(path) : null
}

export async function openCodeWslClient(
  distro: string,
  dbPath: string,
  signal?: AbortSignal
): Promise<OpenCodeSqliteWorkerClient> {
  throwIfSignalAborted(signal)
  const key = distro.toLowerCase()
  const runtime = runtimes.get(key)
  if (!runtime) {
    throw new AiVaultScanIssueError(aiVaultScanIssueText('openCodeWslReaderNotPrepared'))
  }
  if (runtime.error !== undefined) {
    // The preparing placeholder is Orca's own table text; real setup failures stay verbatim.
    throw runtime.error === AI_VAULT_SCAN_ISSUE_COPY.openCodeWslReaderPreparing
      ? new AiVaultScanIssueError(aiVaultScanIssueText('openCodeWslReaderPreparing'))
      : new Error(runtime.error)
  }
  let client = clients.get(key)
  if (!client) {
    client = createOpenCodeSqliteProcessClient({
      executable: resolveWslExecutablePath(),
      args: buildWslExecArgs(distro, [runtime.executable, runtime.readerPath]),
      cwd: resolveWslInteropSpawnCwd(),
      env: { ...buildRelayAiVaultServiceEnv(), WSL_UTF8: '1' },
      async beforeSpawn(spawnSignal) {
        // A `--exec` of a stopped distro boots it; every respawn asks again.
        await waitForPromiseWithSignal(admitWslTranscriptPath(dbPath), spawnSignal)
      },
      // The reader dying may mean its distro stopped: a respawn must not trust an older running read.
      onUnexpectedExit: () => noteWslDistroMayHaveStopped(distro)
    })
    clients.set(key, client)
  }
  return client
}

/** Keep database reads Windows-addressable and the working directory native to its host. */
export function mapOpenCodeWslSession(
  session: AiVaultSession | null,
  dbPath: string
): AiVaultSession | null {
  if (!session) {
    return null
  }
  return {
    ...session,
    id: `${session.executionHostId}:${session.agent}:${session.sessionId}:${dbPath}`,
    filePath: dbPath,
    executionHostPlatform: 'linux'
  }
}
