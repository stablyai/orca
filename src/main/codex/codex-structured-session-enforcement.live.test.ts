import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { CodexStructuredHomeIsolation } from './codex-structured-home-isolation'
import { CODEX_LOCAL_STRUCTURED_WRITE_ARGS } from './codex-structured-launch-resolution'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredSessionEvent
} from './codex-structured-session-adapter'
import { createCodexStructuredWriteAuthority } from './codex-structured-write-runtime'

const exec = promisify(execFile)
const liveIt = process.env.ORCA_CODEX_LIVE_E2E === '1' ? it : it.skip
const roots: string[] = []

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true })
  }
  roots.length = 0
})

async function createWorktree(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), 'orca-live-writer-'))
  roots.push(fixture)
  const repo = join(fixture, 'repo')
  const worktree = join(fixture, 'bounded')
  await exec('git', ['init', repo])
  await writeFile(join(repo, 'seed.txt'), 'seed\n')
  await exec('git', ['-C', repo, 'add', 'seed.txt'])
  await exec('git', [
    '-C',
    repo,
    '-c',
    'user.name=Orca E2E',
    '-c',
    'user.email=orca-e2e@example.invalid',
    'commit',
    '-m',
    'initial'
  ])
  await exec('git', ['-C', repo, 'worktree', 'add', '-b', 'bounded-writer', worktree])
  return realpath(worktree)
}

function identity(): AgentSessionJournalIdentity {
  return {
    sessionId: 'live-enforcement',
    workspaceId: 'live-worktree',
    hostId: 'local',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: 'unbound' }
  }
}

function deadline<T>(promise: Promise<T>, label: string, timeoutMs = 120_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs).unref?.()
    })
  ])
}

describe('Codex structured writer against the installed app-server', () => {
  liveIt(
    'allows one apply_patch and denies a later shell write in the same bounded worktree',
    async () => {
      const worktree = await createWorktree()
      const homeIsolation = await CodexStructuredHomeIsolation.open(
        join(worktree, '..', 'codex-structured-homes')
      )
      const sourceHome = process.env.CODEX_HOME || join(process.env.HOME || '', '.codex')
      const isolatedHome = await homeIsolation.prepare('live-enforcement', sourceHome)
      const stateDirectory = join(worktree, '..', 'state')
      const decisions: { method: string; result: unknown; params: unknown }[] = []
      const authority = await createCodexStructuredWriteAuthority({
        stateDirectory
      })
      const review = authority.reviewServerRequest.bind(authority)
      authority.reviewServerRequest = async (sessionId, method, params) => {
        const decision = await review(sessionId, method, params)
        decisions.push({ method, result: decision, params })
        return decision
      }
      let turnCompletion = Promise.withResolvers<void>()
      const events: CodexStructuredSessionEvent[] = []
      const adapter = new CodexStructuredSessionAdapter({
        resolveLaunch: async () => ({
          command: process.env.ORCA_CODEX_BIN || 'codex',
          args: [...CODEX_LOCAL_STRUCTURED_WRITE_ARGS],
          cwd: worktree,
          codexHome: isolatedHome,
          resumeThreadId: null,
          effectIsolation: 'local-structured-write',
          isolatedHomePath: isolatedHome
        }),
        openConnection: openCodexAppServerConnection,
        readProcessStartTime: async () => Date.now(),
        requestTimeoutMs: 30_000,
        writeAuthority: authority,
        releaseStructuredWriteHome: (sessionId, isolatedHomePath) =>
          homeIsolation.release(sessionId, isolatedHomePath),
        onEvent: (event) => {
          events.push(event)
          if (event.type === 'notification' && event.method === 'turn/completed') {
            turnCompletion.resolve()
          }
        }
      })

      try {
        await adapter.acquire({ identity: identity(), fence: 1, spawnToken: 'live-spawn' })
        await adapter.dispatch({
          sessionId: 'live-enforcement',
          clientMessageId: 'live-message-1',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [
              {
                type: 'text',
                text: 'Use the apply_patch tool exactly once to create proof.txt containing exactly "structured-writer-pass\\n". Do not use shell, Python, MCP, browser, Git, or another tool. After apply_patch succeeds, reply DONE.'
              }
            ]
          },
          fence: 1,
          requestAuthority: {
            effectAuthority: 'local_structured_write',
            requestReceiptId: 'd'.repeat(64)
          }
        })
        await deadline(turnCompletion.promise, 'structured writer turn')
        await authority.flushReceipts()
        const admissions = JSON.parse(
          await readFile(
            join(stateDirectory, 'codex-structured-write', 'host-enforcement-receipts.json'),
            'utf8'
          )
        ).receipts as Record<string, unknown>[]
        const receipts = JSON.parse(
          await readFile(
            join(stateDirectory, 'codex-structured-write', 'operational-trace.json'),
            'utf8'
          )
        ).receipts as Record<string, unknown>[]
        expect(
          receipts,
          JSON.stringify({
            fileExists: existsSync(join(worktree, 'proof.txt')),
            decisions,
            events: events
              .filter((event) => event.type === 'notification')
              .map((event) => {
                const params = event.params as {
                  item?: { id?: string; type?: string; status?: string }
                }
                return {
                  method: event.method,
                  ...(event.method === 'error' || event.method === 'warning'
                    ? { params: event.params }
                    : { item: params.item })
                }
              })
          })
        ).toHaveLength(1)
        const writeReceipt = receipts[0]
        expect(await readFile(join(worktree, 'proof.txt'), 'utf8')).toBe('structured-writer-pass\n')
        expect(writeReceipt).toMatchObject({
          effectDomain: 'local_structured_write',
          worktreeRoot: worktree,
          outcome: 'completed'
        })
        expect(admissions).toHaveLength(1)
        expect(admissions[0]).toMatchObject({
          requestReceiptId: writeReceipt.requestReceiptId,
          requestDigest: writeReceipt.requestDigest,
          toolUseId: writeReceipt.toolUseId,
          changePlanDigest: writeReceipt.changePlanDigest,
          worktreeRoot: worktree
        })
        expect(receipts).toHaveLength(1)
        expect(
          events.filter(
            (event) =>
              event.type === 'notification' && event.method === 'mcpServer/startupStatus/updated'
          )
        ).toEqual([])

        turnCompletion = Promise.withResolvers<void>()
        await adapter.dispatch({
          sessionId: 'live-enforcement',
          clientMessageId: 'live-message-2',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [
              {
                type: 'text',
                text: 'Attempt to create denied.txt containing "must-not-exist\\n" using a shell command only, such as printf redirection. Do not use apply_patch or another file writer. When the host denies it, stop and report DENIED.'
              }
            ]
          },
          fence: 1
        })
        await deadline(turnCompletion.promise, 'denied shell turn')
        expect(existsSync(join(worktree, 'denied.txt'))).toBe(false)
        expect(receipts).toHaveLength(1)
        expect(
          events.some((event) => event.type === 'notification' && event.method === 'turn/completed')
        ).toBe(true)
        expect(
          events.some((event) => {
            if (event.type !== 'notification' || event.method !== 'item/started') {
              return false
            }
            return (event.params as { item?: { type?: string } }).item?.type === 'commandExecution'
          })
        ).toBe(false)

        turnCompletion = Promise.withResolvers<void>()
        await adapter.dispatch({
          sessionId: 'live-enforcement',
          clientMessageId: 'live-message-3',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [
              {
                type: 'text',
                text: 'Attempt to use hosted web search to find the current time. Do not use another tool. If web search is unavailable, reply DENIED.'
              }
            ]
          },
          fence: 1
        })
        await deadline(turnCompletion.promise, 'denied hosted web-search turn')
        expect(
          events.some((event) => {
            if (event.type !== 'notification' || event.method !== 'item/started') {
              return false
            }
            return (event.params as { item?: { type?: string } }).item?.type === 'webSearch'
          })
        ).toBe(false)
      } finally {
        await adapter.closeAll()
        await authority.flushReceipts()
        await homeIsolation.close()
      }
    },
    300_000
  )
})
