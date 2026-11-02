import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deliverClaudeSessionMoveHandoff } from './claude-session-move-handoff'

function writeJob(
  root: string,
  id: string,
  request: { command: string; sessionId: string; createdAt: string },
  extra: { pid?: number; exit?: string } = {}
): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'request.json'), `${JSON.stringify({ id, ...request })}\n`)
  if (extra.pid !== undefined) {
    writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ pid: extra.pid })}\n`)
  }
  if (extra.exit !== undefined) {
    writeFileSync(join(dir, 'exit'), extra.exit)
  }
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots.length = 0
})

describe('deliverClaudeSessionMoveHandoff', () => {
  it('pastes running jobs from the dying session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-handoff-jobs-'))
    roots.push(root)
    const running = 'dj_aaaaaaaaaaaaaaaa'
    const other = 'dj_bbbbbbbbbbbbbbbb'
    const exited = 'dj_cccccccccccccccc'
    const createdAt = '2026-10-29T00:00:00.000Z'
    writeJob(
      root,
      running,
      { command: 'echo stay', sessionId: 'sess-1', createdAt },
      { pid: process.pid }
    )
    writeJob(
      root,
      other,
      { command: 'echo other', sessionId: 'sess-2', createdAt },
      { pid: process.pid }
    )
    writeJob(root, exited, { command: 'echo done', sessionId: 'sess-1', createdAt }, { exit: '0' })

    let pasted = ''
    const result = await deliverClaudeSessionMoveHandoff({
      controller: {
        write: (_ptyId, data) => {
          pasted = data
          return true
        }
      },
      hooks: {
        getStatusSnapshotForPane: () => [
          { state: 'done', receivedAt: 2, providerSession: { id: 'sess-1' } }
        ],
        getProviderSessionIdentities: () => [{ paneKey: 'pane-1', sessionId: 'sess-1' }]
      },
      ptyId: 'pty-1',
      paneKey: 'pane-1',
      sessionId: 'sess-1',
      baselineReceivedAt: 1,
      handoff: {
        fromEmail: 'from@example.com',
        toEmail: 'to@example.com',
        detail: 'session 96%',
        endedWork: { subagents: [] }
      },
      translate: (_key, fallback) => fallback,
      jobRoot: root,
      sleep: async () => {}
    })

    expect(result).toBe('sent')
    expect(pasted).toContain(
      `Detached Orca jobs still running after this restart: ${running} log=${join(root, running, 'output.log')}.`
    )
    expect(pasted).toContain('The restart ended subagents of the previous process (none reported).')
    expect([...new Set(pasted.match(/dj_[a-f0-9]{16}/g))]).toEqual([running])
  })
})
