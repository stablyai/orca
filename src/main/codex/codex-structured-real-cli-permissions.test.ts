import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import { resolveCodexCommand } from '../codex-cli/command'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { codexStructuredPermissionPolicy } from './codex-structured-permission-policy'
import { openCodexThread } from './codex-structured-thread-open'

const enabled = process.env.ORCA_REAL_CODEX_CLI_TEST === '1'

describe.skipIf(!enabled)('Codex real app-server permissions', () => {
  it('starts in Auto and resets inherited policy on cold resume', async () => {
    const base = mkdtempSync(join(tmpdir(), 'orca-real-codex-permissions-'))
    const cwd = join(base, 'workspace')
    const codexHome = join(base, 'codex-home')
    try {
      mkdirSync(cwd, { recursive: true })
      mkdirSync(codexHome, { recursive: true })
      writeFileSync(
        join(codexHome, 'config.toml'),
        'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
      )
      let threadId: string | null = null
      for (const mode of ['auto', 'full-access', 'auto', 'ask'] as const) {
        let turnCompleted = false
        const connection = await openCodexAppServerConnection(
          {
            command: resolveCodexCommand(),
            args: ['app-server'],
            cwd,
            env: { HOME: base, CODEX_HOME: codexHome }
          },
          {
            onNotification: (method) => {
              turnCompleted ||= method === 'turn/completed'
            }
          }
        )
        try {
          const replies: unknown[] = []
          const opened = await openCodexThread(
            {
              request: async (...args) => {
                const reply = await connection.request(...args)
                replies.push(reply)
                return reply
              }
            },
            {
              cwd,
              resumeThreadId: threadId,
              permissionPolicy: codexStructuredPermissionPolicy(mode)
            },
            20_000
          )
          if (threadId !== null) {
            expect(opened.threadId).toBe(threadId)
          }
          threadId = opened.threadId
          expect(replies).toMatchObject([effectivePolicy(mode)])
          // A shell-only turn saves a rollout for the next process without contacting a model.
          await connection.request(
            'thread/shellCommand',
            { threadId, command: 'echo auto-mode-proof' },
            { timeoutMs: 10_000 }
          )
          await vi.waitFor(() => expect(turnCompleted).toBe(true), { timeout: 15_000 })
        } finally {
          await connection.close()
        }
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 120_000)
})

function effectivePolicy(mode: AgentChatPermissionMode) {
  return mode === 'full-access'
    ? {
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        approvalsReviewer: 'user'
      }
    : {
        approvalPolicy: 'on-request',
        sandbox: { type: 'workspaceWrite' },
        approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user'
      }
}
