import type * as AppServerSession from './app-server/codex-app-server-session'
import type * as LocalHistory from '../native-chat/codex-local-history'
import type * as RolloutStream from '../native-chat/codex-rollout-history-stream'
import { readCodexLocalHistory } from '../native-chat/codex-local-history'
import { readCodexRolloutBytes } from '../native-chat/codex-rollout-history-stream'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { codexForkHistory } from './codex-conversation-copy'
import type { CodexAppServerRpc } from './app-server/codex-app-server-session'

const state = vi.hoisted(() => ({
  home: '',
  paths: new Map<string, string>(),
  request: vi.fn<CodexAppServerRpc['request']>(),
  initialize: vi.fn()
}))
vi.mock('../native-chat/codex-local-history', async (importOriginal) => {
  const original = await importOriginal<typeof LocalHistory>()
  return { ...original, readCodexLocalHistory: vi.fn(original.readCodexLocalHistory) }
})
vi.mock('../native-chat/codex-rollout-history-stream', async (importOriginal) => {
  const original = await importOriginal<typeof RolloutStream>()
  return { ...original, readCodexRolloutBytes: vi.fn(original.readCodexRolloutBytes) }
})
vi.mock('../native-chat/session-file-resolver', () => ({
  resolveSessionFilePath: async (_agent: string, id: string) => state.paths.get(id) ?? null
}))
vi.mock('./app-server/codex-app-server-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AppServerSession>()),
  runCodexAppServerSession: async (
    launch: unknown,
    body: (rpc: CodexAppServerRpc) => Promise<unknown>
  ) => {
    state.initialize(launch)
    return body({ request: state.request, notify: () => {} })
  }
}))

const SOURCE = '00000000-0000-4000-8000-000000000001'
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-fork-codex-'))
  state.home = root
  state.paths.clear()
  state.request.mockReset()
  state.initialize.mockReset()
  vi.mocked(readCodexLocalHistory).mockClear()
  vi.mocked(readCodexRolloutBytes).mockClear()
  await mkdir(join(root, 'sessions'), { recursive: true })
})
afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

function message(type: 'UserMessage' | 'AgentMessage', id: string) {
  return {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type, id, content: [{ type: 'text', text: 'repeated identical prompt' }] }
    }
  }
}
function turn(id: string | undefined, n: number) {
  return [
    ...(id ? [{ type: 'event_msg', payload: { type: 'task_started', turn_id: id } }] : []),
    message('UserMessage', `u${n}`),
    message('AgentMessage', `a${n}`),
    ...(id ? [{ type: 'event_msg', payload: { type: 'task_complete', turn_id: id } }] : [])
  ]
}
async function history(id: string, records: object[]) {
  const path = join(root, 'sessions', `rollout-2026-11-04T00-00-00-${id}.jsonl`)
  await writeFile(
    path,
    `${[{ type: 'session_meta', payload: { id, history_mode: 'paginated' } }, ...records].map((row, ordinal) => JSON.stringify({ ...row, ordinal })).join('\n')}\n`
  )
  state.paths.set(id, path)
  return path
}

it('uses exact physical identities across repeated prompts rather than a retained-window offset', async () => {
  const path = await history(SOURCE, [
    ...turn('first', 1),
    ...turn('second', 2),
    ...turn('third', 3)
  ])
  const result = await codexForkHistory({
    path,
    roots: [join(root, 'sessions')],
    sessionId: SOURCE,
    selectedItemId: agentJournalItemKey({
      provider: 'legacy',
      agent: 'codex',
      sessionId: SOURCE,
      recordId: `${SOURCE}:a2`
    })
  })
  expect(result.index).toBe(1)
  expect(result.selected.id).toBe('second')
})
