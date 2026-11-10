// End to end through the host: real sends snapshot a real git worktree before each turn, a real
// rewind goes back to a message, and the checkpoint restore (then its undo) puts the files back.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import type { AgentSessionDispatchOutcome } from '../../providers/structured-agent-session-adapter'
import { hostAgentSessionCheckpoints } from '../../checkpoints/agent-session-checkpoints'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from '../structured-agent-session-logger'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { claudeAndCodexDeclared } from '../../providers/testing/structured-agent-session-adapter-router-test-support'
import { startsWhenPublished } from './structured-agent-session-instant-start.test-support'

const caller = { callerKey: 'desktop' }
let directory: string
let worktree: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
/** What "the agent" does to the worktree when a message reaches it. */
let agentEdits: (() => Promise<void>)[]

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: worktree })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}
const put = async (path: string, text: string) => {
  await mkdir(join(worktree, path, '..'), { recursive: true })
  await writeFile(join(worktree, path), text)
}
const read = (path: string) => readFile(join(worktree, path), 'utf8')

beforeEach(async () => {
  resetHostTestOperationIds()
  agentEdits = []
  directory = await mkdtemp(join(tmpdir(), 'orca-rewind-files-'))
  worktree = await mkdtemp(join(tmpdir(), 'orca-rewind-files-tree-'))
  await git('init', '-q')
  await git('config', 'user.name', 'Audit')
  await git('config', 'user.email', 'audit@example.test')
  await put('.gitignore', 'node_modules/\n')
  await put('app.ts', 'v0\n')
  await git('add', '.')
  await git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'base')
  store = await openTestAgentSessionRecordStore(directory)
  let acquires = 0
  const adapter = startsWhenPublished(
    {
      supportsCreate: (_location, agent) => agent === 'codex',
      supportsLocation: () => true,
      acquire: async (input) => {
        acquires += 1
        return {
          process: {
            hostId: 'local',
            pid: 4000 + acquires,
            processStartTimeMs: HOST_TEST_NOW,
            spawnToken: input.spawnToken
          },
          acquisitionGeneration: `generation-${acquires}`,
          link: {
            linkId: `link-${acquires}`,
            mintedAtFence: input.fence,
            observedAt: HOST_TEST_NOW,
            origin: acquires === 1 ? 'created' : 'resumed',
            handle: codexProviderHandle(HOST_TEST_THREAD)
          }
        }
      },
      dispatch: vi.fn(async (input): Promise<AgentSessionDispatchOutcome> => {
        await agentEdits.shift()?.()
        return {
          state: 'accepted',
          providerIdentity: {
            provider: 'codex',
            threadId: HOST_TEST_THREAD,
            turnId: input.clientMessageId,
            ordinal: 0
          }
        }
      }),
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => {},
      setOption: async () => {},
      rewindSupport: () => ({ supported: true }),
      releaseAcquisition: async () => true,
      closeSession: async () => true
    },
    () => host
  )
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter,
    journalDatabase: openTestJournalHostDatabase(directory),
    claimKeyId: 'key',
    resolveWorkspacePath: async () => worktree,
    now: () => HOST_TEST_NOW,
    probeOwner: async () => ({ outcome: 'exit-observed' })
  })
})
afterEach(async () => {
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
  await rm(worktree, { recursive: true, force: true })
})

async function send(text: string, edit: () => Promise<void>): Promise<string> {
  agentEdits.push(edit)
  const clientOperationId = hostTestOperationId()
  const body = hostTestMessage(text)
  expect(
    await host.send(caller, {
      body,
      envelope: {
        sessionId: HOST_TEST_SESSION,
        clientOperationId,
        expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: HOST_TEST_SESSION,
          fields: { body }
        })
      }
    })
  ).toMatchObject({ ok: true })
  await vi.waitFor(async () =>
    expect(
      (await host.journalSnapshot(HOST_TEST_SESSION)).submissions.find(
        (entry) => entry.clientMessageId === clientOperationId
      )?.dispatchState
    ).toBe('accepted')
  )
  return agentJournalSubmissionKey(clientOperationId)
}

describe('rewind with file restore', () => {
  it('snapshots before each turn and puts files back to the rewound message', async () => {
    const attached = await host.attach(caller, hostTestAttachParams(null))
    expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
    const first = await send('add a feature', async () => {
      await put('app.ts', 'v1\n')
      await put('feature.ts', 'feature\n')
    })
    const second = await send('now refactor', async () => {
      await put('app.ts', 'v2\n')
      await rm(join(worktree, 'feature.ts'))
      await put('refactor/util.ts', 'util\n')
      await put('node_modules/dep/index.js', 'ignored\n')
    })
    const refs = await git('for-each-ref', '--format=%(refname)', 'refs/orca/checkpoints/')
    expect(refs.split('\n')).toHaveLength(2)
    expect(await git('stash', 'list')).toBe('')

    const preview = await hostAgentSessionCheckpoints(host).preview(HOST_TEST_SESSION, second)
    expect(preview).toMatchObject({ available: true, changedFiles: 3, headMoved: false })
    const restored = await hostAgentSessionCheckpoints(host).restore(HOST_TEST_SESSION, second)
    expect(restored.changedFiles).toBe(3)
    expect(await read('app.ts')).toBe('v1\n')
    expect(await read('feature.ts')).toBe('feature\n')
    expect(existsSync(join(worktree, 'refactor'))).toBe(false)
    expect(await read('node_modules/dep/index.js')).toBe('ignored\n')

    await hostAgentSessionCheckpoints(host).undo(HOST_TEST_SESSION, restored.undoId)
    expect(await read('app.ts')).toBe('v2\n')
    expect(existsSync(join(worktree, 'feature.ts'))).toBe(false)
    expect(await read('refactor/util.ts')).toBe('util\n')

    await hostAgentSessionCheckpoints(host).restore(HOST_TEST_SESSION, first)
    expect(await read('app.ts')).toBe('v0\n')
    expect(existsSync(join(worktree, 'feature.ts'))).toBe(false)
  })

  it('has no checkpoint for unknown messages and refuses a bad undo id', async () => {
    const attached = await host.attach(caller, hostTestAttachParams(null))
    expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
    expect(await hostAgentSessionCheckpoints(host).preview(HOST_TEST_SESSION, 'orca:nope')).toEqual({
      available: false,
      reason: 'none'
    })
    await expect(hostAgentSessionCheckpoints(host).restore(HOST_TEST_SESSION, 'orca:nope')).rejects.toThrow(
      'agent_session_checkpoint_none'
    )
    await expect(hostAgentSessionCheckpoints(host).undo(HOST_TEST_SESSION, '../../heads/main')).rejects.toThrow(
      'agent_session_checkpoint_none'
    )
  })
})
