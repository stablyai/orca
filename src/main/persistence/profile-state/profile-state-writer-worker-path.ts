import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-thread-entry-path'

export function resolveProfileStateWriterWorkerPath(moduleDir = __dirname): string {
  const entry = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(moduleDir),
    'profile-state-writer-worker-entry.js'
  )
  return (
    [entry, join(dirname(entry), '..', 'profile-state-writer-worker-entry.js')].find(existsSync) ??
    entry
  )
}
