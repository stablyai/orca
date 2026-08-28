import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { OrchestrationDb } from '../db'
import { readObservedLaunchIdentity } from './certification-event-source'
import {
  observeProviderSessionIdentity,
  persistObservedLaunchReceipt,
  readProviderModelFromTranscript
} from './provider-session-identity'

/** EFFECTIVE_IDENTITY_MUST_COME_FROM_THE_PROVIDER
 *
 *  The launch receipt only ever held what Orca ASKED for, and Claude's hook
 *  reports no model, so `effective_model_identity` could never be earned. The
 *  provider does state its own model — in the transcript it writes itself.
 *
 *  Every control here is a way that transcript could describe something other
 *  than this Dispatch's live session.
 */
describe('EFFECTIVE_IDENTITY_MUST_COME_FROM_THE_PROVIDER', () => {
  let db: OrchestrationDb | undefined
  const dirs: string[] = []
  afterEach(() => {
    db?.close()
    db = undefined
    while (dirs.length) {
      rmSync(dirs.pop() as string, { recursive: true, force: true })
    }
  })

  const TOKEN = 'launch-token-xyz'
  const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')
  const DISPATCHED_AT_MS = Date.parse('2026-08-28T00:00:00.000Z')
  let currentDispatchId = ''

  function transcript(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-transcript-'))
    dirs.push(dir)
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'))
    return path
  }

  function assistant(model: string, at: string) {
    return { type: 'assistant', timestamp: at, message: { model } }
  }

  function world() {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: {
        agent: 'claude',
        launch: {
          requested: { agent: 'claude', model: 'opus', effort: 'high' },
          effective: { agent: 'claude', model: 'opus', effort: 'high' }
        }
      }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf',
      processIncarnation: 'pty_1:inc_1',
      launchTokenHash: TOKEN_HASH,
      worktreeId: 'repo::/wt',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    currentDispatchId = started.dispatch.id
    db!.db
      .prepare('UPDATE dispatch_contexts SET dispatched_at = ? WHERE id = ?')
      .run('2026-08-28 00:00:00', started.dispatch.id)
    return db.getDispatchContextById(started.dispatch.id)!
  }

  function status(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
    return {
      paneKey: 'tab_worker:leaf',
      terminalHandle: 'term_worker',
      launchToken: TOKEN,
      connectionId: null,
      receivedAt: DISPATCHED_AT_MS + 60_000,
      stateStartedAt: DISPATCHED_AT_MS,
      state: 'working',
      agentType: 'claude',
      prompt: '',
      providerSession: { key: 'session_id' as const, id: 'sess_1' },
      orchestration: {
        taskId: 'runtime-owned-task',
        dispatchId: currentDispatchId,
        processIncarnation: 'pty_1:inc_1',
        launchTokenHash: TOKEN_HASH
      },
      ...overrides
    } as AgentStatusIpcPayload
  }

  it('POSITIVE: reads the exact model the provider wrote for this session', () => {
    const dispatch = world()
    const path = transcript([
      assistant('claude-opus-5-20260101', '2026-08-28T00:05:00.000Z'),
      assistant('claude-opus-5-20260101', '2026-08-28T00:06:00.000Z')
    ])
    const verdict = observeProviderSessionIdentity({
      dispatch,
      snapshot: [
        status({
          providerSession: { key: 'session_id' as const, id: 'sess_1', transcriptPath: path }
        })
      ],
      agent: 'claude',
      reasoning: 'high'
    })
    expect(verdict).toMatchObject({
      ok: true,
      observation: {
        identity: { agent: 'claude', model: 'claude-opus-5-20260101', reasoning: 'high' }
      }
    })
  })

  it('NEGATIVE requested-copy: the receipt is not observed until this writes it', () => {
    const dispatch = world()
    // start_options already carries launch.effective — a copy of the request.
    expect(readObservedLaunchIdentity(db!, dispatch.id)).toBeNull()

    const path = transcript([assistant('claude-opus-5-20260101', '2026-08-28T00:05:00.000Z')])
    const verdict = observeProviderSessionIdentity({
      dispatch,
      snapshot: [
        status({
          providerSession: { key: 'session_id' as const, id: 'sess_1', transcriptPath: path }
        })
      ],
      agent: 'claude',
      reasoning: 'high'
    })
    expect(verdict.ok).toBe(true)
    persistObservedLaunchReceipt(db!, {
      dispatchId: dispatch.id,
      identity: verdict.ok ? verdict.observation.identity : ({} as never),
      sessionId: 'sess_1',
      observedAtIso: '2026-08-28T00:06:00.000Z'
    })
    // Only now, and it is the PROVIDER's model, not the requested alias.
    expect(readObservedLaunchIdentity(db!, dispatch.id)).toMatchObject({
      model: 'claude-opus-5-20260101'
    })
  })

  it('NEGATIVE wrong session: another launch in the same pane cannot answer', () => {
    const dispatch = world()
    const path = transcript([assistant('claude-opus-5-20260101', '2026-08-28T00:05:00.000Z')])
    expect(
      observeProviderSessionIdentity({
        dispatch,
        snapshot: [
          status({
            launchToken: 'a-different-launch',
            providerSession: { key: 'session_id' as const, id: 'sess_other', transcriptPath: path }
          })
        ],
        agent: 'claude',
        reasoning: 'high'
      })
    ).toMatchObject({ ok: false, code: 'no_status_for_dispatch' })
  })

  it('NEGATIVE old process: a report from another terminal or pane is refused', () => {
    const dispatch = world()
    const path = transcript([assistant('claude-opus-5-20260101', '2026-08-28T00:05:00.000Z')])
    const session = { key: 'session_id' as const, id: 'sess_1', transcriptPath: path }
    expect(
      observeProviderSessionIdentity({
        dispatch,
        snapshot: [status({ paneKey: 'tab_other:leaf', providerSession: session })],
        agent: 'claude',
        reasoning: 'high'
      })
    ).toMatchObject({ ok: false, code: 'no_status_for_dispatch' })
    expect(
      observeProviderSessionIdentity({
        dispatch,
        snapshot: [status({ terminalHandle: 'term_other', providerSession: session })],
        agent: 'claude',
        reasoning: 'high'
      })
    ).toMatchObject({ ok: false, code: 'no_status_for_dispatch' })
  })

  it('NEGATIVE stale transcript: a model written before this Dispatch is refused', () => {
    const dispatch = world()
    const path = transcript([assistant('claude-opus-5-OLD', '2020-01-01T00:00:00.000Z')])
    expect(
      observeProviderSessionIdentity({
        dispatch,
        snapshot: [
          status({
            providerSession: { key: 'session_id' as const, id: 'sess_1', transcriptPath: path }
          })
        ],
        agent: 'claude',
        reasoning: 'high'
      })
    ).toMatchObject({ ok: false, code: 'stale_transcript' })
  })

  it('NEGATIVE: a session that has named no model yet proves nothing', () => {
    const dispatch = world()
    const path = transcript([{ type: 'user', timestamp: '2026-08-28T00:05:00.000Z' }])
    expect(
      observeProviderSessionIdentity({
        dispatch,
        snapshot: [
          status({
            providerSession: { key: 'session_id' as const, id: 'sess_1', transcriptPath: path }
          })
        ],
        agent: 'claude',
        reasoning: 'high'
      })
    ).toMatchObject({ ok: false, code: 'no_provider_model' })
  })

  it('prefers a hook-reported model when a harness supplies one', () => {
    const dispatch = world()
    const verdict = observeProviderSessionIdentity({
      dispatch,
      snapshot: [status({ model: 'claude-opus-5-from-hook' })],
      agent: 'claude',
      reasoning: 'high'
    })
    expect(verdict).toMatchObject({
      ok: true,
      observation: { identity: { model: 'claude-opus-5-from-hook' } }
    })
  })

  it('reads the newest assistant model, not the first', () => {
    const path = transcript([
      assistant('older', '2026-08-28T00:01:00.000Z'),
      assistant('newest', '2026-08-28T00:09:00.000Z')
    ])
    expect(readProviderModelFromTranscript(path)).toMatchObject({ model: 'newest' })
  })

  it('refuses a missing or different launch token even in the same pane', () => {
    const dispatch = world()
    const path = transcript([assistant('claude-opus-5', '2026-08-28T00:05:00.000Z')])
    const session = { key: 'session_id' as const, id: 'sess_1', transcriptPath: path }
    // Runtime projection enriches hook rows with Dispatch context, but it must
    // not manufacture the provider process's launch-token possession.
    const noToken = status({ providerSession: session })
    delete (noToken as { launchToken?: string }).launchToken
    expect(
      observeProviderSessionIdentity({
        dispatch,
        snapshot: [noToken],
        agent: 'claude',
        reasoning: 'high'
      })
    ).toMatchObject({ ok: false, code: 'no_status_for_dispatch' })
    // A report carrying a DIFFERENT token is still another session.
    expect(
      observeProviderSessionIdentity({
        dispatch,
        snapshot: [status({ launchToken: 'other-launch', providerSession: session })],
        agent: 'claude',
        reasoning: 'high'
      })
    ).toMatchObject({ ok: false, code: 'no_status_for_dispatch' })
  })

  it('takes the AGENT from Orca own launch record, never from the provider', () => {
    const dispatch = world()
    const path = transcript([assistant('claude-opus-5', '2026-08-28T00:05:00.000Z')])
    const verdict = observeProviderSessionIdentity({
      dispatch,
      // The provider reports no agentType at all; Orca chose the launcher.
      snapshot: [
        status({
          agentType: undefined,
          providerSession: { key: 'session_id', id: 's', transcriptPath: path }
        })
      ],
      agent: 'claude',
      reasoning: 'high'
    })
    expect(verdict).toMatchObject({ ok: true, observation: { identity: { agent: 'claude' } } })
  })

  it('returns nothing for a transcript that does not exist', () => {
    expect(readProviderModelFromTranscript('/nope/missing.jsonl')).toBeNull()
  })
})
