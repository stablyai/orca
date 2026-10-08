import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'
import {
  adapterAtPublishFor,
  fakeClaude,
  identityFor,
  recordingJournalSink
} from './claude-structured-session-test-support'

const SESSION = 'claude_forked_chat'
const FORKED_FROM = {
  sessionId: 'claude_parent_chat',
  itemId: 'claude:provider:answer-1',
  providerSessionId: 'parent-conversation',
  forkPoint: 'leaf-1'
}

const homes: string[] = []
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })))

function accountHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'claude-launch-fork-'))
  homes.push(home)
  mkdirSync(join(home, 'projects', '-workspace'), { recursive: true })
  return home
}

/** A chat reserved as a fork of another, in the state `chain` leaves it. */
function forkRecord(
  home: string,
  chain: AgentSessionRecord['providerHandleChain'] = []
): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(),
    sessionId: SESSION,
    provider: 'claude',
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: home },
    forkedFrom: FORKED_FROM,
    providerHandleChain: chain
  }
}

function launch(record: AgentSessionRecord, forkSession: () => Promise<string>) {
  const head = record.providerHandleChain.at(-1)?.handle
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async () => '/repos/workspace-1',
    resolveCommand: () => '/usr/local/bin/claude',
    resolveAuthPolicy: () => ({ stripAuthEnv: false }),
    resolveLaunchArgs: () => [],
    forkSession
  })({
    identity: { ...identityFor(SESSION), providerHandle: head ?? null }
  })
}

describe('the first start of a forked Claude chat', () => {
  it('has Claude copy the parent through the forked turn, and resumes the copy', async () => {
    const home = accountHome()
    const forkSession = vi.fn(async () => 'copy-1')

    const resolved = await launch(forkRecord(home), forkSession)

    expect(forkSession).toHaveBeenCalledWith({
      claudeConfigDir: home,
      providerSessionId: 'parent-conversation',
      upToMessageId: 'leaf-1'
    })
    expect(resolved).toMatchObject({
      providerSessionId: 'copy-1',
      resumesTranscript: true,
      forked: true
    })
    expect(resolved.options).toMatchObject({ resume: 'copy-1' })
    expect(resolved.options).not.toHaveProperty('sessionId')
  })

  it('resumes the copy it already holds on every later start, and copies nothing', async () => {
    const home = accountHome()
    writeFileSync(join(home, 'projects', '-workspace', 'copy-1.jsonl'), '{}\n')
    const forkSession = vi.fn(async () => 'copy-2')
    const held = forkRecord(home, [
      {
        linkId: 'link-1',
        origin: 'adopted',
        mintedAtFence: 1,
        observedAt: 1,
        handle: claudeProviderHandle('copy-1', null)
      }
    ])

    const resolved = await launch(held, forkSession)

    expect(forkSession).not.toHaveBeenCalled()
    expect(resolved.options).toMatchObject({ resume: 'copy-1' })
    expect(resolved).not.toHaveProperty('forked')
  })

  it('adopts the copy as a conversation it did not start, and says where its history is', async () => {
    const home = accountHome()
    const copyPath = join(home, 'projects', '-workspace', 'copy-1.jsonl')
    writeFileSync(copyPath, '{}\n')
    const adapter = adapterAtPublishFor(fakeClaude(), {
      claudeConfigDir: home,
      providerSessionId: 'copy-1',
      resumesTranscript: true,
      forked: true
    })

    const acquisition = await adapter.acquire({
      identity: identityFor(SESSION),
      fence: 1,
      spawnToken: 'spawn-1',
      events: recordingJournalSink()
    })

    expect(acquisition.link).toMatchObject({
      origin: 'adopted',
      handle: claudeProviderHandle('copy-1', null)
    })
    // Read from the live session, so any start whose journal is still empty can ask again.
    expect(await adapter.forkedHistory(SESSION)).toEqual({
      providerSessionId: 'copy-1',
      transcriptPath: copyPath
    })
    // A transcript it owes and cannot find is a refusal, never "nothing to import".
    rmSync(copyPath)
    await expect(adapter.forkedHistory(SESSION)).rejects.toMatchObject({
      refusal: { details: { reason: 'transcriptNotFound' } }
    })
    await adapter.closeAll()
  })
})
