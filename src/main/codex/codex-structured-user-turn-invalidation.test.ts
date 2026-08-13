import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexStructuredSessionControl } from './codex-structured-session-control'
import type { CodexSession } from './codex-structured-session-state'
import { CodexStructuredWriteAuthority } from './codex-structured-write-authority'

const roots: string[] = []

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots.length = 0
})

function linkedWorktree(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'orca-trusted-user-turn-'))
  roots.push(fixture)
  const root = join(fixture, 'worktree')
  const gitDir = join(fixture, 'repo', '.git', 'worktrees', 'bounded')
  mkdirSync(root, { recursive: true })
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'gitdir'), `${join(root, '.git')}\n`)
  return realpathSync(root)
}

function session(
  request: CodexAppServerConnection['request'],
  effectIsolation?: 'local-structured-write'
): CodexSession {
  return {
    connection: {
      pid: 42,
      closed: false,
      request,
      notify: vi.fn(),
      respond: vi.fn(),
      respondWithError: vi.fn(),
      close: vi.fn(async () => undefined)
    },
    threadId: 'thread-1',
    historyPath: null,
    prompts: { clear: vi.fn() } as unknown as CodexSession['prompts'],
    options: new Map(),
    reportedOptions: {},
    turnIdWaiters: [],
    translator: null,
    isolatedHomePath: null,
    effectIsolation
  }
}

describe('trusted user turn writer invalidation', () => {
  it('revokes and closes every other active writer before a local user send proceeds', async () => {
    const interrupt = vi.fn(async () => ({}))
    const writer = session(interrupt, 'local-structured-write')
    const normal = session(vi.fn(async () => ({})))
    const authority = {
      activeTurn: vi.fn(() => ({ threadId: 'writer-thread', turnId: 'writer-turn' })),
      invalidateTurnEpoch: vi.fn()
    } as unknown as CodexStructuredWriteAuthority
    const terminate = vi.fn(async () => undefined)
    const control = new CodexStructuredSessionControl(
      new Map([
        ['writer-session', writer],
        ['normal-session', normal]
      ]),
      {
        resolveLaunch: vi.fn(),
        writeAuthority: authority
      },
      terminate
    )

    await control.invalidateEffectAuthorityForTrustedUserTurn({
      sourceSessionId: 'normal-session'
    })

    expect(authority.invalidateTurnEpoch).toHaveBeenCalledWith('writer-session')
    expect(interrupt).toHaveBeenCalledWith(
      'turn/interrupt',
      { threadId: 'writer-thread', turnId: 'writer-turn' },
      { timeoutMs: undefined }
    )
    expect(terminate).toHaveBeenCalledWith('writer-session')
  })

  it('invalidates an authorization that resolves after the newer user epoch', async () => {
    const root = linkedWorktree()
    const grant = Promise.withResolvers<{
      requestReceiptId: string
      writableRoot: string
      capabilityHandle: string
    }>()
    const authority = new CodexStructuredWriteAuthority({
      authorizeTurn: () => grant.promise,
      consumeLease: () => undefined,
      onReceipt: () => undefined
    })
    await authority.bindSession('writer-session', root)
    const opening = authority.openTurn({
      sessionId: 'writer-session',
      clientMessageId: 'client-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'write' }] },
      fence: 1
    })

    authority.invalidateTurnEpoch('writer-session')
    grant.resolve({ requestReceiptId: 'receipt', writableRoot: root, capabilityHandle: 'handle' })

    await expect(opening).resolves.toBeNull()
    expect(authority.activeTurn('writer-session')).toBeNull()
  })
})
