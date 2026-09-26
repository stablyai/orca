import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { RemoteOpenCodeSessionReader } from '../main/ai-vault/remote-session-scanner-types'
import { throwIfAiVaultScanCancelled } from '../main/ai-vault/ai-vault-scan-cancellation'
import { isMissingRemoteSessionPathError } from '../main/ai-vault/remote-session-file-stat'
import { parseOpenCodeSessionFile } from '../main/ai-vault/session-scanner-opencode-parser'
import { createOpenCodeSqliteProcessClient } from '../main/ai-vault/session-scanner-opencode-sqlite-process-client'
import { buildRelayAiVaultServiceEnv } from '../main/ai-vault/session-scanner-service-env'
import { resolveOpenCodeDataDirectory } from '../main/opencode/opencode-data-directory'
import SyncDatabase from '../main/sqlite/sync-database'

type Reader = Pick<RemoteOpenCodeSessionReader, 'list' | 'parse'> & { dispose(): void }

export type RelayOpenCodeReaderOptions = {
  baseDir?: string
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
  currentExecutable?: string
  readerFactory?: (options: Parameters<typeof createOpenCodeSqliteProcessClient>[0]) => Reader
  canReadSqlite?: () => boolean
}

export function createRelayOpenCodeReader(
  options: RelayOpenCodeReaderOptions = {}
): RemoteOpenCodeSessionReader & { dispose(): void } {
  const environment = options.environment ?? process.env
  const dataDirectory = resolveOpenCodeDataDirectory(
    environment,
    options.homeDirectory ?? homedir()
  )
  const override = environment.OPENCODE_DB?.trim()
  const baseDir = options.baseDir ?? __dirname
  let reader: Reader | undefined
  let executable: string | undefined
  let pending: Promise<Reader> | undefined
  let disposed = false
  const getReader = (refreshRuntime = false): Promise<Reader> => {
    if (disposed) {
      return Promise.reject(new Error('OpenCode database reader was disposed.'))
    }
    if (reader && !refreshRuntime) {
      return Promise.resolve(reader)
    }
    pending ??= (async () => {
      const configured = await readRuntimeExecutable(join(baseDir, 'opencode-sqlite-runtime.json'))
      if (!configured && !(options.canReadSqlite ?? canCurrentRuntimeReadSqlite)()) {
        throw new Error('OpenCode history is waiting for its database reader on this host.')
      }
      if (disposed) {
        throw new Error('OpenCode database reader was disposed.')
      }
      const nextExecutable = configured ?? options.currentExecutable ?? process.execPath
      if (!reader || executable !== nextExecutable) {
        reader?.dispose()
        reader = (options.readerFactory ?? createOpenCodeSqliteProcessClient)({
          executable: nextExecutable,
          args: [join(baseDir, 'opencode-sqlite-reader.cjs')],
          env: buildRelayAiVaultServiceEnv(environment)
        })
        executable = nextExecutable
      }
      return reader
    })().finally(() => {
      pending = undefined
    })
    return pending
  }
  return {
    dataDirectory,
    ...(override
      ? {
          databasePath:
            override === ':memory:'
              ? null
              : isAbsolute(override)
                ? override
                : join(dataDirectory, override)
        }
      : {}),
    async list(args) {
      throwIfAiVaultScanCancelled(args.signal)
      if (args.dbPaths.length === 0) {
        return []
      }
      try {
        return await (await getReader(true)).list(args)
      } catch (error) {
        throwIfAiVaultScanCancelled(args.signal)
        args.issues.push({
          agent: args.agent ?? 'opencode',
          kind: 'scope',
          path: args.dbPaths[0] ?? dataDirectory,
          message: error instanceof Error ? error.message : String(error)
        })
        return []
      }
    },
    async parse(args) {
      throwIfAiVaultScanCancelled(args.signal)
      return (await getReader()).parse(args)
    },
    parseLegacy: parseOpenCodeSessionFile,
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      reader?.dispose()
    }
  }
}

async function readRuntimeExecutable(path: string): Promise<string | undefined> {
  let file
  try {
    file = await open(path, 'r')
  } catch (error) {
    if (isMissingRemoteSessionPathError(error)) {
      return undefined
    }
    throw error
  }
  try {
    const bytes = Buffer.alloc(16_385)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 16_384) {
      throw new Error('OpenCode database runtime reference exceeds its size limit.')
    }
    const reference: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    if (
      typeof reference !== 'object' ||
      reference === null ||
      !('protocol' in reference) ||
      reference.protocol !== 1 ||
      !('executable' in reference) ||
      typeof reference.executable !== 'string' ||
      !isAbsolute(reference.executable) ||
      reference.executable.includes('\0')
    ) {
      throw new Error('OpenCode database runtime reference is invalid.')
    }
    return reference.executable
  } finally {
    await file.close()
  }
}

function canCurrentRuntimeReadSqlite(): boolean {
  let db: SyncDatabase | undefined
  try {
    db = new SyncDatabase(':memory:')
    return db.prepare('SELECT 1 AS ready').get()?.ready === 1
  } catch {
    return false
  } finally {
    db?.close()
  }
}
