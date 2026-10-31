import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { resolveCodexCommand } from '../codex-cli/command'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { openCodexThread } from './codex-structured-thread-open'

it.skipIf(process.env.ORCA_REAL_CODEX_CLI_TEST !== '1')(
  'forks actual provider history and cold-resumes the independent child with selected permissions',
  async () => {
    const base = mkdtempSync(join(tmpdir(), 'orca-real-side-chat-'))
    const cwd = join(base, 'workspace')
    const codexHome = join(base, 'codex-home')
    mkdirSync(cwd)
    mkdirSync(codexHome)
    const launch = {
      command: resolveCodexCommand(),
      args: ['app-server'],
      cwd,
      env: { HOME: base, USERPROFILE: base, CODEX_HOME: codexHome }
    }
    let finished = false
    let allClosed = true
    const parent = await openCodexAppServerConnection(launch, {
      onNotification: (method) => {
        finished ||= method === 'turn/completed'
      }
    })
    try {
      const source = await openCodexThread(parent, { cwd, resumeThreadId: null }, 20_000)
      await parent.request(
        'thread/shellCommand',
        { threadId: source.threadId, command: 'echo orca-side-chat-context-proof' },
        { timeoutMs: 10_000 }
      )
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 15_000 })
      const before = await parent.request('thread/read', {
        threadId: source.threadId,
        includeTurns: true
      })
      const child = await openCodexAppServerConnection(launch, { onNotification: () => {} })
      let childId: string
      try {
        const opened = await openCodexThread(
          child,
          {
            cwd,
            resumeThreadId: null,
            forkThreadId: source.threadId,
            sideChat: true,
            permissionPolicy: {
              sandbox: 'danger-full-access',
              approvalPolicy: 'never',
              approvalsReviewer: 'user'
            }
          },
          20_000
        )
        childId = opened.threadId
        expect(childId).not.toBe(source.threadId)
        expect(opened.reportedPermissionMode).toBe('full-access')
        const history = await child.request('thread/read', {
          threadId: childId,
          includeTurns: true
        })
        expect(JSON.stringify(history)).toContain('orca-side-chat-context-proof')
        expect(
          await parent.request('thread/read', { threadId: source.threadId, includeTurns: true })
        ).toEqual(before)
      } finally {
        allClosed = (await child.close()) && allClosed
      }
      const resumed = await openCodexAppServerConnection(launch, { onNotification: () => {} })
      try {
        const reopened = await openCodexThread(
          resumed,
          {
            cwd,
            resumeThreadId: childId,
            sideChat: true,
            permissionPolicy: {
              sandbox: 'read-only',
              approvalPolicy: 'on-request',
              approvalsReviewer: 'user'
            }
          },
          20_000
        )
        expect(reopened.threadId).toBe(childId)
        expect(reopened.reportedPermissionMode).toBe('ask')
      } finally {
        allClosed = (await resumed.close()) && allClosed
      }
    } finally {
      allClosed = (await parent.close()) && allClosed
      if (allClosed) {
        rmSync(base, { recursive: true, force: true })
      }
      expect(allClosed).toBe(true)
    }
  },
  120_000
)
