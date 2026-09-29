import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { backfillManagedCodexSessionsIntoSystemHome } from './codex-session-backfill'
import type { CodexSessionBackfillPaths } from './codex-session-backfill-types'

let root: string
let paths: CodexSessionBackfillPaths

function writeManaged(relativePath: string, contents: string): void {
  const path = join(paths.managedSessionsRoot, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-worker-backfill-'))
  paths = {
    managedSessionsRoot: join(root, 'managed', 'sessions'),
    systemSessionsRoot: join(root, 'system', 'sessions'),
    auditLogPath: join(root, 'audit', 'audit.jsonl'),
    markerPath: join(root, 'audit', 'backfill-complete.json')
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Orca worker session backfill', () => {
  it('keeps a dispatched worker in Orca while publishing an ordinary Codex chat', async () => {
    const workerPath = join('2026', '05', '26', 'rollout-worker.jsonl')
    const workerPrompt = [
      'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.',
      'Your task ID is: task_abc123',
      'orca orchestration send --task-id task_abc123 --dispatch-id ctx_def456'
    ].join('\n')
    const workerRollout = `${[
      { type: 'session_meta', payload: { id: 'session_worker' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for /repo' }]
        }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: workerPrompt }]
        }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`
    writeManaged(workerPath, workerRollout)
    const userPath = join('2026', '05', '26', 'rollout-user.jsonl')
    writeManaged(userPath, 'ordinary chat\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(paths)

    expect(summary).toMatchObject({ linkedFiles: 1, skippedWorkerFiles: 1, deferredFiles: 0 })
    expect(existsSync(join(paths.systemSessionsRoot, workerPath))).toBe(false)
    expect(existsSync(join(paths.managedSessionsRoot, workerPath))).toBe(true)
    expect(readFileSync(join(paths.systemSessionsRoot, userPath), 'utf8')).toBe('ordinary chat\n')
  })

  it('defers a rollout until its first prompt is available', async () => {
    const relativePath = join('2026', '05', '26', 'rollout-starting.jsonl')
    writeManaged(
      relativePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session_starting' }
      })}\n`
    )

    const summary = await backfillManagedCodexSessionsIntoSystemHome(paths)

    expect(summary).toMatchObject({ linkedFiles: 0, deferredFiles: 1, failedFiles: 0 })
    expect(existsSync(join(paths.systemSessionsRoot, relativePath))).toBe(false)
  })

  it('does not republish a rollout Codex has archived', async () => {
    const relativePath = join('2026', '05', '26', 'rollout-archived.jsonl')
    writeManaged(relativePath, 'managed worker session\n')
    const archivedPath = join(root, 'system', 'archived_sessions', 'rollout-archived.jsonl')
    mkdirSync(dirname(archivedPath), { recursive: true })
    writeFileSync(archivedPath, 'archived worker session\n')

    const summary = await backfillManagedCodexSessionsIntoSystemHome(paths)

    expect(summary).toMatchObject({ linkedFiles: 0, skippedExistingFiles: 1 })
    expect(existsSync(join(paths.systemSessionsRoot, relativePath))).toBe(false)
    expect(readFileSync(archivedPath, 'utf8')).toBe('archived worker session\n')
  })
})
