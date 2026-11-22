import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { writeOwnerOnlyFileDurable } from '../../filesystem/owner-only-durable-file-write'
import { SlackExecutionBinding } from '../slack-execution-binding'

export function openSlackExecutions(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path)
  try {
    hardenSqliteDatabaseFiles(path)
    db.exec(
      'CREATE TABLE IF NOT EXISTS slack_execution_bindings (session_id TEXT PRIMARY KEY, binding TEXT NOT NULL)'
    )
  } catch (error) {
    db.close()
    throw error
  }
  return {
    async call(op: string, [key, value]: readonly unknown[]) {
      if (typeof key !== 'string') {
        throw new Error('Missing Slack execution key')
      }
      switch (op) {
        case 'reserve':
          db.prepare(
            'INSERT INTO slack_execution_bindings (session_id, binding) VALUES (?, ?)'
          ).run(key, JSON.stringify(SlackExecutionBinding.parse(value)))
          return { found: true }
        case 'read': {
          const entry = db
            .prepare('SELECT binding FROM slack_execution_bindings WHERE session_id = ?')
            .get(key)
          if (typeof entry?.binding !== 'string') {
            throw new Error('Slack execution binding is missing')
          }
          return { found: true, value: SlackExecutionBinding.parse(JSON.parse(entry.binding)) }
        }
        case 'writeMemory':
          if (typeof value !== 'string') {
            throw new Error('Invalid Slack requester memory content')
          }
          await writeOwnerOnlyFileDurable(key, value)
          return { found: true }
        default:
          return { found: false }
      }
    },
    dispose: () => db.close()
  }
}
