import type { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import { setHeavyWorkerHost } from '../../../utility-worker-host/heavy-worker-spawn'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'

export function useClaudeImportWorker(
  onSpawn?: (worker: Worker) => void,
  preload = ''
): () => void {
  const host = { spawn: spawnWorkerThread, retry() {}, pauseMessage: () => null }
  setHeavyWorkerHost({
    ...host,
    spawn(filename, options) {
      if (options.name !== 'orca-claude-history-import') {
        return host.spawn(filename, options)
      }
      const entry = resolve(
        'src/main/native-chat/agent-session-journal/history-import/journal-claude-import-worker-entry.ts'
      )
      const worker = spawnWorkerThread(
        `${preload}\nrequire('tsx/cjs'); require(${JSON.stringify(entry)})`,
        {
          ...options,
          eval: true,
          execArgv: []
        }
      )
      onSpawn?.(worker)
      return worker
    }
  })
  return () => setHeavyWorkerHost(host)
}
