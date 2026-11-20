import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareLegacyTranscriptImport } from '../native-chat/agent-session-journal/history-import/journal-legacy-import'
import { ANTIGRAVITY_TRANSCRIPT_IMPORT } from './antigravity-transcript-import'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'
import { adoptsCliConversations } from '../../shared/agent-session/view/structured-agent-cli-conversation-adoption'
import { conversationFamily } from '../native-chat/conversation-adoption/structured-conversation-key'

let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
  root = null
})

const CONVERSATION = 'c8d1836b-555c-4775-b77d-1430c7f358f5'

it("finds an agy terminal conversation in agy's own store and imports its words", async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-agy-import-'))
  const agyHome = { variable: 'GEMINI_HOME', path: join(root, '.gemini') }
  const logs = join(
    agyHome.path,
    'antigravity-cli',
    'brain',
    CONVERSATION,
    '.system_generated',
    'logs'
  )
  mkdirSync(logs, { recursive: true })
  writeFileSync(
    join(logs, 'transcript_full.jsonl'),
    [
      '{"step_index":"0","source":"USER_EXPLICIT","type":"USER_INPUT","created_at":"2026-11-19T07:33:08Z","content":"<USER_REQUEST>\\nRemember ZEBRA\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>\\ntime\\n</ADDITIONAL_METADATA>"}',
      '{"step_index":"1","source":"MODEL","type":"PLANNER_RESPONSE","created_at":"2026-11-19T07:33:09Z","content":"noted"}',
      '{"step_index":"2","source":"SYSTEM","type":"SYSTEM_MESSAGE","content":"internal notice"}',
      ''
    ].join('\n')
  )

  // Orca's managed Antigravity home cannot see agy's terminal conversations.
  expect(
    ANTIGRAVITY_TRANSCRIPT_IMPORT.conversationStore({
      accountHome: { variable: 'GEMINI_HOME', path: join(root, 'antigravity-chat') },
      launchEnv: {}
    })
  ).toBeNull()
  const store = ANTIGRAVITY_TRANSCRIPT_IMPORT.conversationStore({
    accountHome: agyHome,
    launchEnv: {}
  })
  expect(store).toBe(join(agyHome.path, 'antigravity-cli'))
  const transcriptPath = await ANTIGRAVITY_TRANSCRIPT_IMPORT.findTranscript({
    providerSessionId: CONVERSATION,
    store: store!,
    launchEnv: {},
    workspaceCwd: root
  })
  expect(transcriptPath).toBe(join(logs, 'transcript_full.jsonl'))

  const imported = await prepareLegacyTranscriptImport({
    agent: 'antigravity',
    sessionId: CONVERSATION,
    options: { filePath: transcriptPath! }
  })
  expect(imported).toMatchObject({
    ok: true,
    items: [
      {
        identity: {
          provider: 'legacy',
          agent: 'antigravity',
          sessionId: CONVERSATION,
          recordId: 'step:0'
        },
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Remember ZEBRA' }]
        }
      },
      {
        identity: {
          provider: 'legacy',
          agent: 'antigravity',
          sessionId: CONVERSATION,
          recordId: 'step:1'
        },
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'noted' }]
        }
      }
    ]
  })
  // Another conversation's transcript never stands in for the requested one.
  expect(
    await prepareLegacyTranscriptImport({
      agent: 'antigravity',
      sessionId: 'another-conversation',
      options: { filePath: transcriptPath! }
    })
  ).toMatchObject({ ok: false })
})

it('recognizes agy terminal resumes of a conversation', () => {
  const parse = ANTIGRAVITY_LAUNCH_SPEC.sessionHistory.parseResumeArgs
  expect(parse(['--conversation', CONVERSATION])).toEqual({ target: CONVERSATION })
  expect(parse([`--conversation=${CONVERSATION}`])).toEqual({ target: CONVERSATION })
  expect(parse(['-c'])).toBeNull()
  expect(parse(['-i', 'hello'])).toBeNull()
})

it('offers agy terminal conversations to chats, also from an agy set up with an API key', async () => {
  expect(adoptsCliConversations('antigravity')).toBe(true)
  expect(conversationFamily('antigravity')).toBe('antigravity')

  root = mkdtempSync(join(tmpdir(), 'orca-agy-key-'))
  const agyHome = { variable: 'GEMINI_HOME', path: join(root, '.gemini') }
  mkdirSync(join(agyHome.path, 'antigravity-cli'), { recursive: true })
  const candidates = () =>
    ANTIGRAVITY_TRANSCRIPT_IMPORT.accountHomeCandidates({
      settings: {},
      selectedAccountHome: agyHome
    })
  expect(await candidates()).toContainEqual(agyHome)
  writeFileSync(
    join(agyHome.path, 'antigravity-cli', 'settings.json'),
    '{"modelProvider":"gemini-api-key"}'
  )
  expect(await candidates()).toContainEqual(agyHome)
})
