import '../unused-default-rpc-methods.test-fixture'
vi.mock('node:fs/promises', { spy: true })
import { readFile, rm } from 'node:fs/promises'
import { piRpcDialogPresentation } from '../../../pi/rpc-extension-dialogs'
import { legacyAgentSessionSelectedOptionId } from '../../../../shared/agent-session-question-answer'
import type {
  AgentJournalItemBody,
  AgentJournalResolution,
  AgentJournalQuestionItem
} from '../../../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session-journal-types'
import { expect, it, vi } from 'vitest'
import { hostTestMessage } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { REST_TEST_SESSION as SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import * as fileOperations from 'node:fs/promises'
import * as contextSnapshots from '../../../native-chat/agent-session-context-snapshots'

import {
  fixture,
  actualFiles,
  call,
  restingChat
} from './structured-agent-session-rest-contract-test-fixture'

it('hands off the reduced saved chat after clear and rewind, budgets only the starter and overwrites its file', async () => {
  await restingChat()
  await fixture.rig.host.journalSnapshot(SESSION)
  let journal = fixture.rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const fence = fixture.rig.store.getRecord(SESSION)!.lease.runtimeFence
  const receipt = { write: () => {}, committed: () => {} }
  let ordinal = 100
  const append = (text: string | AgentJournalItemBody, itemOrdinal = ordinal++) =>
    journal.appendItem(
      { provider: 'codex', threadId: 'saved-thread', turnId: 'saved-turn', ordinal: itemOrdinal },
      typeof text === 'string' ? hostTestMessage(text) : text,
      {
        fence: fixture.rig.store.getRecord(SESSION)!.lease.runtimeFence,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )
  await append('PRE_CLEAR_SECRET')
  await journal.context.clear(
    { operationId: 'pr-31782-clear', afterFence: fence, clearedAt: fixture.rig.clock.now },
    receipt
  )
  await append('EARLY_SAVED_MARKER')
  for (let index = 0; index < 205; index++) {
    await append(`saved ${index} ${'context '.repeat(60)}`)
  }
  const floor = journal.cursor()
  await append('DISCARDED_REWIND_SECRET')
  await journal.context.rewind(floor, fence, [], () => receipt)
  const resolution = (
    state: AgentJournalResolution['state'],
    selectedOptionId: string | null = null
  ): AgentJournalResolution => ({ state, selectedOptionId, resolvedBy: null, resolvedAt: null })
  const question = (name: string, answer?: string): AgentJournalQuestionItem => ({
    kind: 'question',
    question: name,
    options: [],
    freeTextQuestionId: 'input',
    freeTextInput: { allowEmpty: true },
    resolution: {
      ...resolution('resolved'),
      ...(answer !== undefined
        ? { answers: [{ questionId: 'input', optionIds: [], other: answer }] }
        : {})
    }
  })
  for (const [name, value] of [
    ['deployment', '  deploy to staging  '],
    ['explicit empty', ''],
    ['whitespace', ' \t']
  ]) {
    await append(question(name, value))
  }
  await append(question('unreadable'))
  await append({ ...question('cancelled ask'), resolution: resolution('cancelled') })
  await append({
    ...question('legacy answer'),
    resolution: resolution('resolved', 'input:legacy%20deployment')
  })
  await append({
    kind: 'question',
    question: 'Release choices',
    options: [],
    questions: [
      {
        id: 'regions',
        header: 'Region group',
        question: 'Which regions?',
        multiSelect: true,
        options: [
          { id: 'east', label: 'East', description: 'Primary region' },
          { id: 'west', label: 'West' }
        ]
      },
      {
        id: 'details',
        question: 'Release detail?',
        multiSelect: true,
        options: [{ id: 'known', label: 'Known' }],
        freeTextQuestionId: 'details'
      }
    ],
    resolution: {
      ...resolution('resolved'),
      answers: [
        { questionId: 'regions', optionIds: ['east', 'west'] },
        { questionId: 'details', optionIds: ['known', 'missing'], other: 'partial text' }
      ]
    }
  })
  for (const choice of ['yes', 'no']) {
    await append({
      kind: 'approval',
      title: `Confirm ${choice}`,
      detail: 'Deploy?',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' }
      ],
      resolution: resolution('resolved', choice)
    })
  }
  await append({
    kind: 'approval',
    title: 'Review plan',
    description: 'Saved description',
    decisionReason: 'Saved reason',
    matchedAskRule: { source: 'workspace', toolName: 'Write', ruleContent: 'Saved ask rule' },
    blockedPath: '/work/target',
    detail: 'Clipped detail',
    subject: { kind: 'plan', text: 'RETAINED_PLAN_MARKER', filePath: '/work/plan.md' },
    options: [
      { id: 'plan', label: 'Approve plan' },
      { id: 'keep', label: 'Keep planning' }
    ],
    resolution: resolution('resolved', 'keep')
  })
  const editor = piRpcDialogPresentation({
    id: 'editor',
    method: 'editor',
    title: 'Edit release notes',
    prefill: 'RETAINED_EDITOR_MARKER\nHold deployment',
    placeholder: 'Keep migration details'
  })
  if (editor?.body.kind !== 'question') {
    throw new Error('Pi editor missing')
  }
  const editorOrdinal = ordinal++
  await append(editor.body, editorOrdinal)
  const editorParams = {
    sessionId: SESSION,
    workspaceId: 'workspace-1',
    expectedCursor: { epoch: journal.cursor().epoch, sequence: 0 }
  }
  const pendingEditor = await fixture.rig.host.continuationContext(editorParams)
  if (pendingEditor.status !== 'current' || !pendingEditor.transcriptPath) {
    throw new Error('Pending editor snapshot missing')
  }
  for (const text of [
    await readFile(pendingEditor.transcriptPath, 'utf8'),
    pendingEditor.capturedText ?? ''
  ]) {
    expect(text).toContain(
      'Prompt state: pending\nSaved prompt: {"kind":"question","question":"Edit release notes"'
    )
    expect(text).toContain('"initialValue":"RETAINED_EDITOR_MARKER\\nHold deployment"')
    expect(text).toContain('"placeholder":"Keep migration details"')
  }
  const answers = [{ questionId: 'editor', optionIds: [], other: 'REPLACEMENT_EDITOR_ANSWER' }]
  const selectedOptionId = legacyAgentSessionSelectedOptionId(editor.body, answers)
  await append(
    { ...editor.body, resolution: { ...resolution('resolved', selectedOptionId), answers } },
    editorOrdinal
  )
  await fixture.rig.restart()
  setStructuredAgentSessionHost(fixture.rig.host)
  const snapshot = await fixture.rig.host.journalSnapshot(SESSION)
  journal = fixture.rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await append({ ...question('pending ask'), resolution: resolution('pending') })
  const params = {
    sessionId: SESSION,
    workspaceId: 'workspace-1',
    expectedCursor: { epoch: snapshot.cursor.epoch, sequence: 0 }
  }
  await call('agentSession.options', { sessionId: SESSION })
  const gate = Promise.withResolvers<void>()
  const write = actualFiles.writeFile
  const writing = vi.spyOn(fileOperations, 'writeFile').mockImplementationOnce(async (...args) => {
    await gate.promise
    return write(...args)
  })
  const pending = fixture.rig.host.continuationContext(params)
  await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce())
  const currentJournal = fixture.rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await currentJournal.appendItem(
    { provider: 'orca', clientMessageId: 'pr-31782-late' },
    hostTestMessage('LATER_SAVED_MARKER'),
    {
      fence: fixture.rig.store.getRecord(SESSION)!.lease.runtimeFence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  gate.resolve()
  const first = await pending
  if (first.status !== 'current' || !first.transcriptPath) {
    throw new Error('Snapshot missing')
  }
  const path = first.transcriptPath
  try {
    const file = await readFile(path, 'utf8')
    expect(file).toContain('EARLY_SAVED_MARKER')
    expect(file).not.toMatch(/PRE_CLEAR_SECRET|DISCARDED_REWIND_SECRET|LATER_SAVED_MARKER/)
    expect(first.capturedText?.length).toBeLessThanOrEqual(36_000)
    expect(first.capturedText).toContain('Earlier saved chat messages omitted')
    expect(first.capturedText).not.toContain('EARLY_SAVED_MARKER')
    for (const text of [file, first.capturedText ?? '']) {
      const prompts: unknown[] = [...text.matchAll(/^Saved prompt: (.+)$/gm)].map((match) =>
        JSON.parse(match[1]!)
      )
      for (const [name, value] of [
        ['deployment', '  deploy to staging  '],
        ['explicit empty', ''],
        ['whitespace', ' \t']
      ]) {
        expect(prompts).toContainEqual(expect.objectContaining(question(name, value)))
      }
      expect(text).toMatch(
        /"question":"unreadable"[^\n]*\nQuestion "input"\nSubmitted answer: unavailable/
      )
      expect(text).toMatch(/Prompt state: pending\nSaved prompt: .*"question":"pending ask"/)
      expect(text).toMatch(/Prompt state: cancelled\nSaved prompt: .*"question":"cancelled ask"/)
      const legacy = text.split('\n\n').find((row) => row.includes('"question":"legacy answer"'))!
      expect(legacy).toContain('"selectedOptionId":"input:legacy%20deployment"')
      expect(legacy.split('Legacy free text: "legacy deployment"')).toHaveLength(2)
      expect(text).toContain(
        'Question "regions" (Region group)\nSelected choice: East\nSelected choice: West'
      )
      expect(text).toContain('"question":"Which regions?"')
      expect(text).toContain('"label":"East","description":"Primary region"')
      expect(text).toContain(
        'Question "details"\nSelected choice: Known\nSelected choice: unavailable\nSubmitted free text: resolution.answers[1].other'
      )
      expect(text).toContain('"other":"partial text"')
      expect(text).toMatch(/Confirm yes[\s\S]*Selected choice: Yes/)
      expect(text).toMatch(/Confirm no[\s\S]*Selected choice: No/)
      expect(text).toContain(
        '"subject":{"kind":"plan","text":"RETAINED_PLAN_MARKER","filePath":"/work/plan.md"}'
      )
      expect(text).toContain(
        '"matchedAskRule":{"source":"workspace","toolName":"Write","ruleContent":"Saved ask rule"}'
      )
      expect(text).toContain('Selected choice: Keep planning')
      const row = text
        .split('\n\n')
        .find((entry) => entry.includes('"question":"Edit release notes"'))!
      expect(row).toContain('Prompt state: resolved')
      expect(row).toContain(JSON.stringify(editor.body.freeTextInput))
      expect(row).toContain(JSON.stringify(answers))
      expect(row).toContain(`"selectedOptionId":${JSON.stringify(selectedOptionId)}`)
      expect(row.split('\n').slice(2).join('\n')).toBe(
        'Question "editor"\nSubmitted free text: resolution.answers[0].other'
      )
    }
    expect(await call('agentSession.continuationContext', params)).toMatchObject([
      {
        ok: true,
        result: {
          status: 'current',
          transcriptPath: path,
          capturedText: expect.stringContaining('LATER_SAVED_MARKER')
        }
      }
    ])
    expect(await readFile(path, 'utf8')).toContain('LATER_SAVED_MARKER')
    expect(await fixture.rig.host.continuationContext({ ...params, workspaceId: 'other' })).toEqual(
      {
        status: 'superseded'
      }
    )
    expect(
      await fixture.rig.host.continuationContext({
        ...params,
        expectedCursor: { epoch: 'other', sequence: 0 }
      })
    ).toEqual({ status: 'superseded' })
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
    writing.mockRejectedValueOnce(new Error('disk unavailable'))
    expect(await call('agentSession.continuationContext', params)).toMatchObject([{ ok: false }])
  } finally {
    await rm(contextSnapshots.agentSessionContextSnapshotRoot(fixture.rig.root), {
      recursive: true,
      force: true
    })
  }
})
