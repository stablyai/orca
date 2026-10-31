import { mkdir, realpath, rename, writeFile } from 'node:fs/promises'
vi.mock('../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async (original) => {
  const query = await import('../transcript-opencode-sqlite-query')
  return {
    ...(await original<object>()),
    readOpenCodeTranscriptPageViaWorker: query.readOpenCodeTranscriptPage,
    readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
  }
})
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createTestParams,
  CREATE_TEST_CALLER as CALLER
} from './structured-agent-session-create-test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import {
  codexLegacyMirrorRecords,
  writeCodexHistoryFixture
} from '../agent-session-journal/codex-history-test-fixture'
import { structuredAgentRuntimeMetadata } from '../../runtime/structured-agent-runtime-metadata'
import {
  resolveStructuredAgentSessionAdoptionForCreate,
  structuredAgentSessionAdoptAttach
} from '../../runtime/structured-agent-session-create-adoption'
import { prepareCodexAiVaultSessionResume } from '../../codex/codex-ai-vault-session-resume'

import { fixture } from './structured-agent-session-create-adoption-contract-test-fixture'

it.each([
  ['matching', THREAD],
  ['legacy', THREAD],
  ['mismatched', '019fd532-7c11-7a90-b6de-4e1a2c3d5f61']
] as const)(
  'resolves a selected-account rollout with %s metadata before at-rest publication',
  async (_kind, metadataId) => {
    vi.stubEnv('ORCA_USER_DATA_PATH', join(fixture.rig.root, 'host-data'))
    const accountHome = { variable: 'CODEX_HOME', path: join(fixture.rig.root, 'selected-account') }
    const sessions = join(accountHome.path, 'sessions')
    await mkdir(sessions, { recursive: true })
    const rollout = await writeCodexHistoryFixture(
      sessions,
      THREAD,
      ['saved CLI turn'],
      undefined,
      metadataId
    )
    if (_kind === 'legacy') {
      await writeFile(
        rollout.filePath,
        [
          { type: 'session_meta', payload: { id: THREAD, cwd: fixture.rig.root } },
          ...codexLegacyMirrorRecords()
        ]
          .map((record) => JSON.stringify(record))
          .join('\n')
      )
    }
    if (metadataId !== THREAD) {
      // Keep filename lookup valid so the imported metadata is what refuses the mismatched source.
      await rename(rollout.filePath, join(sessions, `rollout-2026-10-27T00-00-00-${THREAD}.jsonl`))
    }
    const metadata = structuredAgentRuntimeMetadata('codex')
    if (!metadata?.transcriptImport) {
      throw new Error('Codex transcript importer is not registered')
    }
    const adoption = await resolveStructuredAgentSessionAdoptionForCreate({
      settings: {},
      agent: 'codex',
      transcriptImport: metadata.transcriptImport,
      providerSessionId: THREAD,
      selectedAccountHome: accountHome,
      launchEnv: {},
      workspaceCwd: fixture.rig.root,
      prepareCodexResume: (args) =>
        prepareCodexAiVaultSessionResume(args, {
          runtimeHome: null,
          systemCodexHomePath: join(fixture.rig.root, 'system-account'),
          preparePinnedLaunchHome: async () => {
            throw new Error('At-rest adoption must not ready a fork launch')
          }
        })
    })
    expect(adoption.accountHome).toEqual(accountHome)
    expect(adoption.transcriptPath).toBe(
      await realpath(join(sessions, `rollout-2026-10-27T00-00-00-${THREAD}.jsonl`))
    )
    const result = await fixture.rig.host.create(
      CALLER,
      createTestParams(undefined, {
        accountHome: adoption.accountHome,
        adopt: structuredAgentSessionAdoptAttach({
          definition: metadata.definition,
          handleNamesTranscript: metadata.transcriptImport.handleNamesTranscript,
          conversationStore:
            metadata.transcriptImport.conversationStore({
              accountHome: adoption.accountHome,
              launchEnv: {}
            }) ?? undefined,
          transcriptPath: adoption.transcriptPath,
          providerSessionId: THREAD,
          workspaceCwd: fixture.rig.root
        })
      })
    )
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
    expect(fixture.rig.adapter.dispatch).not.toHaveBeenCalled()
    if (metadataId !== THREAD) {
      expect(result).toMatchObject({
        ok: false,
        refusal: {
          code: 'agent_session_identity_required',
          details: { reason: 'transcriptUnreadable' },
          createAttemptRefusedBeforeCommit: true
        }
      })
      expect(fixture.rig.store.listRecords()).toEqual([])
      expect(fixture.rig.store.listOperationRows()).toEqual([])
      expect(fixture.rig.store.listVisibleSessionIds()).toEqual([])
      return
    }
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('Real selected-account adoption failed')
    }
    const snapshot = await fixture.rig.host.journalSnapshot(SESSION)
    expect(snapshot.items.map(({ body }) => body)).toEqual(
      _kind === 'legacy'
        ? [
            { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Prompt' }] },
            {
              kind: 'message',
              role: 'system',
              blocks: [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }]
            },
            { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Response' }] }
          ]
        : [
            { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'saved CLI turn' }] },
            {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'saved CLI turn answer' }]
            }
          ]
    )
    expect(result.value.page.items).toEqual(snapshot.items)
    expect(fixture.rig.store.getRecord(SESSION)?.accountHome).toEqual(accountHome)
    expect(fixture.rig.store.getRecord(SESSION)?.providerHandleChain).toMatchObject([
      { origin: 'adopted', mintedAtFence: 1, handle: { nativeId: THREAD } }
    ])
    expect(fixture.rig.store.listVisibleSessionIds()).toEqual([SESSION])
  }
)
