import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getHermesHome } from '../hermes/hermes-default-home'
import { hermesResumeSessionId } from '../../shared/hermes-session-id'
import {
  readOpenCodeTranscriptPageViaWorker,
  readOpenCodeTranscriptSignalViaWorker
} from '../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { needsWslHostResolution } from './host-readable-transcript-path'
import { parseSshTranscriptPath } from './ssh-transcript-path'
import type { OpenCodeTranscriptDeps } from './transcript-opencode'
import type { ResolveSessionFileOptions } from './session-file-resolver'

export function canReadHermesTranscriptHere(options: ResolveSessionFileOptions): boolean {
  const path = options.transcriptPath?.trim()
  return (
    !options.wslDistro?.trim() &&
    !(path && (parseSshTranscriptPath(path) || needsWslHostResolution(path)))
  )
}

export const hermesTranscriptDeps: OpenCodeTranscriptDeps = {
  resolveDbPath: async (sessionId, signal) => {
    signal?.throwIfAborted()
    const target = hermesResumeSessionId(sessionId)
    if (!target) {
      return null
    }
    const home = getHermesHome()
    const profiles = join(home, 'profiles')
    let names: string[] = []
    try {
      names = (await readdir(profiles, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .slice(0, 32)
    } catch (error) {
      signal?.throwIfAborted()
      if (
        !(
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        )
      ) {
        throw error
      }
    }
    let found: string | null = null
    for (const path of [
      join(home, 'state.db'),
      ...names.map((name) => join(profiles, name, 'state.db'))
    ]) {
      signal?.throwIfAborted()
      try {
        await access(path)
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        ) {
          continue
        }
        throw error
      }
      const match = await readOpenCodeTranscriptSignalViaWorker(
        { dbPath: path, sessionId: target, agent: 'hermes' },
        signal
      )
      if (match) {
        if (found) {
          return null
        }
        found = path
      }
    }
    return found
  },
  readSignal: (dbPath, sessionId, signal) =>
    readOpenCodeTranscriptSignalViaWorker({ dbPath, sessionId, agent: 'hermes' }, signal),
  readPage: (args, signal) =>
    readOpenCodeTranscriptPageViaWorker({ ...args, agent: 'hermes' }, signal)
}
