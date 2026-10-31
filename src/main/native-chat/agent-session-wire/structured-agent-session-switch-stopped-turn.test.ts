import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { selectStructuredAgentTurnBars } from '../../../shared/structured-agent-session-turn-timing'
import {
  SWITCH_STOPPED_CLI_TURN_ID,
  SWITCH_STOPPED_CLI_TURN_ITEMS,
  SWITCH_STOPPED_CLI_USER_ITEM_KEY
} from '../../../shared/native-chat/switch-stopped-cli-turn.test-fixture'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'
import {
  captureSwitchStoppedCliTurn,
  catchUpSwitchedCliTranscript
} from './structured-agent-session-switch-import'

// The host half of "a switch-stopped CLI turn shows Interrupted": the recorded working turn is
// imported, stopped by the switch, and settles as a person's Stop with no invented elapsed time.
// The journal it leaves is the shared fixture the chat's own test renders.
it('settles an imported turn a switch stopped as a Stop, with no invented elapsed time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-switch-stopped-turn-'))
  const journals = createTrackedJournalOpener()
  const deadline = agentSessionSwitchDeadline()
  try {
    const recording = await readFile(
      join(import.meta.dirname, '__fixtures__/claude-cli-switch-2.1.302.jsonl'),
      'utf8'
    )
    const rows = recording.trimEnd().split('\n')
    const sessionId: string = JSON.parse(rows[0]!).sessionId
    const filePath = join(root, 'cli.jsonl')
    await writeFile(filePath, `${rows.slice(0, 2).join('\n')}\n`)
    const source = { agent: 'claude' as const, sessionId, filePath }
    const imported = await journals.open({
      stateDirectory: root,
      identity: {
        sessionId: 'imported-stop',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'claude',
        providerHandle: claudeProviderHandle(sessionId, null)
      }
    })
    expect(
      await importLegacyTranscriptIntoJournal({
        journal: imported,
        agent: 'claude',
        sessionId,
        fence: 1,
        options: { filePath }
      })
    ).toMatchObject({ ok: true, replaced: true })
    // Still working when imported: nothing has settled yet.
    expect(
      selectStructuredAgentTurnBars(imported.snapshot().items, [], null).settledTurns.size
    ).toBe(0)
    const stopped = await captureSwitchStoppedCliTurn(source, true, deadline)
    expect(stopped).toMatchObject({
      userItemKey: SWITCH_STOPPED_CLI_USER_ITEM_KEY,
      turnId: SWITCH_STOPPED_CLI_TURN_ID
    })
    await catchUpSwitchedCliTranscript({
      journal: imported,
      source,
      fence: 1,
      deadline,
      stopped: stopped!
    })
    const snapshot = imported.snapshot()
    expect(snapshot.items).toEqual(
      SWITCH_STOPPED_CLI_TURN_ITEMS.map((item) =>
        item.body.kind === 'turn' ? { ...item, observedAt: expect.any(Number) } : item
      )
    )
    const bars = selectStructuredAgentTurnBars(snapshot.items, [], null)
    expect(bars.settledTurns.get(SWITCH_STOPPED_CLI_USER_ITEM_KEY)).toEqual({
      startedAt: null,
      workedSeconds: null,
      verdict: 'cancellation'
    })
    expect(bars.runningTiming).toBeNull()
  } finally {
    deadline.dispose()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})

// A Claude paused mid-reply (Ctrl+Z) sends no Stop: the switch knows only its own proven stop, so
// the transcript must still show the turn open, and a finished one is never relabelled.
it('takes a stopped Claude turn from the transcript alone, and only while it is open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-switch-stopped-turn-'))
  const deadline = agentSessionSwitchDeadline()
  try {
    const recording = await readFile(
      join(import.meta.dirname, '__fixtures__/claude-cli-switch-2.1.302.jsonl'),
      'utf8'
    )
    const rows = recording.trimEnd().split('\n')
    const sessionId: string = JSON.parse(rows[0]!).sessionId
    const source = { agent: 'claude' as const, sessionId, filePath: join(root, 'cli.jsonl') }
    await writeFile(source.filePath, `${rows.slice(0, 2).join('\n')}\n`)
    expect(await captureSwitchStoppedCliTurn(source, 'stopping', deadline)).toMatchObject({
      userItemKey: SWITCH_STOPPED_CLI_USER_ITEM_KEY,
      turnId: SWITCH_STOPPED_CLI_TURN_ID
    })
    await writeFile(source.filePath, `${rows.join('\n')}\n`)
    expect(await captureSwitchStoppedCliTurn(source, 'stopping', deadline)).toBeUndefined()
  } finally {
    deadline.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
