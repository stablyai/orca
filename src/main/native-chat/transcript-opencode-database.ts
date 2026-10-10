import { homedir } from 'node:os'
import { wslGatedAccess } from './wsl-transcript-fs-access'
import { join } from 'node:path'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { getAiVaultWslHomeDirs } from '../ai-vault/cached-session-list'
import { prepareOpenCodeWslReaders } from '../ai-vault/opencode-wsl-runtime-preparation'
import {
  configureOpenCodeWslReaders,
  openCodeWslPath
} from '../ai-vault/session-scanner-opencode-wsl-client'
import { readOpenCodeTranscriptSignalViaWorker } from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import {
  compareOpenCodeClaimPriority,
  listOpenCodeDatabases,
  listOpenCodeDatabasesInDirectory
} from '../opencode-usage/opencode-database-discovery'

// ZCode sessions belong only to its own store.
function zcodeTranscriptDatabasePaths(wslHomeDirs: readonly string[]): string[] {
  return [homedir(), ...wslHomeDirs].map((home) => join(home, '.zcode', 'cli', 'db', 'db.sqlite'))
}

export async function discoverOpenCodeTranscriptDatabase(
  sessionId?: string,
  signal?: AbortSignal,
  agent?: 'zcode'
): Promise<string | null> {
  signal?.throwIfAborted()
  const deadline = new AbortController()
  const timer = setTimeout(
    () =>
      deadline.abort(new Error('OpenCode transcript database discovery exceeded its time limit')),
    5000
  )
  timer.unref?.()
  const boundedSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  const refusals: Error[] = []
  const onRefusal = (_path: string, error: Error): void => {
    refusals.push(error)
  }
  const probed = new Set<string>()
  async function findSession(paths: readonly string[]): Promise<string | null> {
    for (const dbPath of [...new Set(paths)].sort(compareOpenCodeClaimPriority)) {
      if (probed.size >= 32) {
        break
      }
      if (probed.has(dbPath)) {
        continue
      }
      boundedSignal.throwIfAborted()
      probed.add(dbPath)
      try {
        if (
          agent === 'zcode' &&
          !(await waitForPromiseWithSignal(
            wslGatedAccess(dbPath, 'exact', boundedSignal),
            boundedSignal
          ))
        ) {
          continue
        }
        if (!sessionId) {
          return dbPath
        }
        if (
          await waitForPromiseWithSignal(
            readOpenCodeTranscriptSignalViaWorker(
              { dbPath, sessionId, ...(agent ? { agent } : {}) },
              boundedSignal
            ),
            boundedSignal
          )
        ) {
          return dbPath
        }
      } catch (error) {
        boundedSignal.throwIfAborted()
        if (
          agent === 'zcode' &&
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          continue
        }
        refusals.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return null
  }
  try {
    if (agent === 'zcode') {
      const native = await findSession(zcodeTranscriptDatabasePaths([]))
      if (native) {
        return native
      }
      const homes = (await waitForPromiseWithSignal(getAiVaultWslHomeDirs(), boundedSignal)).slice(
        0,
        32
      )
      if (homes.length > 0) {
        const readers = await waitForPromiseWithSignal(
          prepareOpenCodeWslReaders(homes),
          boundedSignal
        )
        boundedSignal.throwIfAborted()
        configureOpenCodeWslReaders(readers)
      }
      const wsl = await findSession(zcodeTranscriptDatabasePaths(homes))
      if (wsl) {
        return wsl
      }
      if (refusals[0]) {
        throw refusals[0]
      }
      return null
    }
    const primary = await waitForPromiseWithSignal(
      listOpenCodeDatabases(onRefusal, undefined, boundedSignal),
      boundedSignal
    )
    // Unrelated WSL setup must not hold up a matching native database.
    const native = await findSession(primary.filter((path) => !openCodeWslPath(path)))
    if (native) {
      return native
    }
    const homes = await waitForPromiseWithSignal(getAiVaultWslHomeDirs(), boundedSignal)
    const sources = await waitForPromiseWithSignal(
      Promise.all(
        homes
          .slice(0, 32)
          .map((home) =>
            listOpenCodeDatabasesInDirectory(
              join(home, '.local', 'share', 'opencode'),
              onRefusal,
              boundedSignal
            )
          )
      ),
      boundedSignal
    )
    const primaryWsl = primary.filter((path) => openCodeWslPath(path))
    const readerRoots = [...new Set([...homes, ...primaryWsl])]
    if (readerRoots.length > 0) {
      const readers = await waitForPromiseWithSignal(
        prepareOpenCodeWslReaders(readerRoots),
        boundedSignal
      )
      boundedSignal.throwIfAborted()
      configureOpenCodeWslReaders(readers)
    }
    const wsl = await findSession([...primaryWsl, ...sources.flat()])
    if (wsl) {
      return wsl
    }
    if (refusals[0]) {
      throw refusals[0]
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}
