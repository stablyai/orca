import { describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../../../../daemon/emulation/headless-emulator'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../../orca-runtime-tests/agent-transcript-pane-test-harness'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'

const ERROR_GLYPH = '■'
// Codex 0.164 bytes after its app-server was killed and reconnect gave up (#24791).
const INLINE_OUTPUT =
  `\x1b[1;20r\x1b[15;1H\r\n\x1b[39;49m\x1b[K\x1b[38;5;1;49m${ERROR_GLYPH} Automatic reconnect could not ` +
  'restore this session. Your draft is still editable.\x1b[39m\r\n'
// A narrow alternate screen wraps the cell with cursor moves; split it to straddle two chunks.
const NARROW_ALT_SCREEN_CHUNKS = [
  `\x1b[?1049h\x1b[17;1H\x1b[38;5;1;49m${ERROR_GLYPH} Automatic reconnect could`,
  ' not\x1b[18;1Hrestore this session. Your\x1b[19;1Hdraft is still editable.\x1b[39m'
]

async function startWorkerPane(launchAgent: TuiAgent) {
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Worker',
    foregroundProcess: launchAgent,
    launchAgent,
    data: ''
  })
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'o',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'work', runId: run.id })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle,
    paneKey: makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111'),
    processIncarnation: 'inc-1',
    worktreeId: 'wt-1',
    effects: [],
    setupState: 'skipped'
  })
  db.markWorkerDispatchReady(dispatch.id)
  runtime.setOrchestrationDb(db)
  const write = async (chunks: readonly string[]) => {
    for (const chunk of chunks) {
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, 1)
    }
    await runtime.readTerminal(handle)
  }
  return { db, write, runtime, handle, runId: run.id, dispatchId: dispatch.id }
}

describe('Codex reconnect failure inside a live worker PTY', () => {
  it.each([
    ['inline', [INLINE_OUTPUT]],
    ['narrow alternate-screen', NARROW_ALT_SCREEN_CHUNKS]
  ])('fails the dispatch and escalates for %s output', async (_mode, chunks) => {
    const { db, write, runId, dispatchId } = await startWorkerPane('codex')
    try {
      await write(chunks)
      expect({
        dispatch: db.getDispatchContextById(dispatchId)?.status,
        worker: db.getWorkerDispatch(dispatchId)?.state,
        stage: db.getWorkerDispatch(dispatchId)?.stage,
        escalations: db
          .getUnreadRunMailbox(runId, 100, ['escalation'])
          .map((message) => message.subject)
      }).toEqual({
        dispatch: 'failed',
        worker: 'failed',
        stage: 'agent_session_lost',
        escalations: ['Worker lost without reporting']
      })
    } finally {
      db.close()
    }
  })

  it.each(['trailing', 'covered', 'repeated', 'invalidated'] as const)(
    'preserves current native actions and later output through %s recovery',
    async (mode) => {
      const { db, runtime, handle, runId, dispatchId } = await startWorkerPane('codex')
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const originalWrite = HeadlessEmulator.prototype.write
      const heldWrite = vi
        .spyOn(HeadlessEmulator.prototype, 'write')
        .mockImplementationOnce(async function (this: HeadlessEmulator, data, options) {
          entered.resolve()
          await release.promise
          await originalWrite.call(this, data, options)
        })
      try {
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, INLINE_OUTPUT, 1)
        await entered.promise
        const seq = runtime.getPtyOutputSequence(TRANSCRIPT_PANE_PTY_ID)
        const trailing = mode === 'covered' ? [] : [{ data: INLINE_OUTPUT, seq }]
        runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
          TRANSCRIPT_PANE_PTY_ID,
          {
            data: mode === 'covered' ? `earlier screen\r\n${INLINE_OUTPUT}` : 'earlier screen\r\n',
            cols: 80,
            rows: 24,
            seq: mode === 'covered' ? seq : 0
          },
          trailing
        )
        if (mode === 'repeated') {
          runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
            TRANSCRIPT_PANE_PTY_ID,
            { data: 'second screen\r\n', cols: 80, rows: 24, seq: 0 },
            trailing
          )
        } else if (mode === 'invalidated') {
          runtime.preparePtyExecutionContext(TRANSCRIPT_PANE_PTY_ID, null, {
            resetIncarnation: true
          })
        }
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, 'LATER LIVE SUFFIX\r\n', 2)
        release.resolve()
        await runtime.readTerminal(handle)
        const escalations = db
          .getUnreadRunMailbox(runId, 100, ['escalation'])
          .map((message) => message.subject)
        if (mode === 'invalidated') {
          expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
          expect(escalations).toEqual([])
        } else {
          expect({
            dispatch: db.getDispatchContextById(dispatchId)?.status,
            worker: db.getWorkerDispatch(dispatchId)?.state,
            stage: db.getWorkerDispatch(dispatchId)?.stage,
            escalations
          }).toEqual({
            dispatch: 'failed',
            worker: 'failed',
            stage: 'agent_session_lost',
            escalations: ['Worker lost without reporting']
          })
        }
        const screen = await runtime.serializeMainTerminalBuffer(TRANSCRIPT_PANE_PTY_ID)
        expect(screen?.data).toContain('LATER LIVE SUFFIX')
        expect(screen?.data.match(/Automatic reconnect/g) ?? []).toHaveLength(
          mode === 'invalidated' ? 0 : 1
        )
        if (mode !== 'invalidated') {
          expect(screen?.data.indexOf('Automatic reconnect')).toBeLessThan(
            screen?.data.indexOf('LATER LIVE SUFFIX') ?? 0
          )
        }
      } finally {
        release.resolve()
        heldWrite.mockRestore()
        db.close()
      }
    }
  )

  it('ignores the text when a Codex pane shows it as indented output', async () => {
    const { db, write, dispatchId } = await startWorkerPane('codex')
    try {
      await write([
        `    \u2514 docs: ${ERROR_GLYPH} Automatic reconnect could not restore this session.\r\n`
      ])
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    } finally {
      db.close()
    }
  })

  it('ignores the same text printed in a non-Codex pane', async () => {
    const { db, write, dispatchId } = await startWorkerPane('claude')
    try {
      await write([INLINE_OUTPUT])
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    } finally {
      db.close()
    }
  })
})
