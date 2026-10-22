import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../shared/structured-agent-session-send-mutation'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { readAcpRecoveryHistory } from '../acp/acp-recovery-history'
import type { AcpStructuredLaunch } from '../acp/acp-structured-launch-resolution'
import { createJournalReducerState } from '../native-chat/agent-session-journal/journal-reducer'
import { reconcileSubmissions } from '../native-chat/agent-session-journal/journal-submission-reconciler'
import { ompStoredUserMessagesReader } from './omp-acp-stored-messages'

const PROVIDER = '0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a'
const FILE = `2026-10-12T00-00-00-000Z_${PROVIDER}.jsonl`
const SESSION = 'session-alpha-1'
const identity = {
  sessionId: SESSION,
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'omp',
  providerHandle: null
}
let root: string
let cwd: string
let home: string
let agentRoot: string
let env: Record<string, string>

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-omp-recovery-')))
  home = join(root, 'home')
  cwd = join(home, 'project')
  agentRoot = join(root, 'account')
  await mkdir(cwd, { recursive: true })
  env = {
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: agentRoot,
    TMPDIR: join(root, 'temp'),
    TEMP: join(root, 'temp')
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function turn(id: string, parentId: string | null, text: string, timestamp = 205) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }], timestamp }
  }
}

async function save(
  records: unknown[],
  options: { bucket?: string; dir?: string; file?: string; suffix?: string } = {}
) {
  const dir = join(options.dir ?? join(agentRoot, 'sessions'), options.bucket ?? '-project')
  await mkdir(dir, { recursive: true })
  const file = join(dir, options.file ?? FILE)
  const header = { type: 'session', version: 3, id: PROVIDER, cwd }
  await writeFile(
    file,
    [header, ...records].map((record) => JSON.stringify(record)).join('\n') +
      (options.suffix ?? '\n')
  )
  return file
}

function submission(
  id: string,
  text: string,
  submittedAt: number,
  accepted = false
): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }]
    }),
    dispatchState: accepted ? 'accepted' : 'unknown',
    providerItemId: null,
    reason: null,
    submittedAt,
    resolvedAt: accepted ? submittedAt + 1 : null
  }
}

async function recover(text = 'run tests', priorSubmissions: AgentJournalSubmission[] = []) {
  const state = createJournalReducerState(SESSION, 'epoch-1')
  for (const entry of [...priorSubmissions, submission('held', text, 200)]) {
    state.submissions.set(entry.clientMessageId, entry)
  }
  const launch: AcpStructuredLaunch = {
    spec: acpLaunchSpecFor('omp')!,
    command: 'omp',
    args: ['acp'],
    cwd,
    env,
    envToDelete: [],
    fullAccess: false,
    resume: {
      sessionId: PROVIDER,
      key: `acp:omp:${PROVIDER}`,
      mayBeUnsaved: () => false,
      unannouncedLosses: () => []
    }
  }
  const window = await readAcpRecoveryHistory(
    {
      spec: { readStoredUserMessages: ompStoredUserMessagesReader() },
      readLaunch: async () => launch,
      readJournal: () => ({ state, damage: null, newer: null })
    },
    identity
  )
  return {
    window,
    outcomes: window
      ? reconcileSubmissions({ submissions: [...state.submissions.values()], history: window })
      : null
  }
}

describe('OMP restart delivery evidence', () => {
  it('confirms a saved user message, even across compaction, using its provider entry ID', async () => {
    await save([
      turn('delivered', null, 'run tests'),
      {
        type: 'message',
        id: 'kept',
        parentId: 'delivered',
        timestamp: new Date(208).toISOString(),
        message: { role: 'assistant', content: 'OK' }
      },
      {
        type: 'compaction',
        id: 'compact',
        parentId: 'kept',
        firstKeptEntryId: 'kept',
        summary: 'run tests',
        tokensBefore: 100,
        timestamp: new Date(210).toISOString()
      }
    ])
    const { window, outcomes } = await recover()
    expect(window).toMatchObject({ boundaryConsistent: false, turnInFlight: true })
    expect(outcomes).toMatchObject([
      { clientMessageId: 'held', outcome: 'accepted', providerItemId: 'delivered' }
    ])
  })

  it.each(['unrelated request', 'run tests'])(
    'never reuses pre-send text when an earlier %s is still uncertain',
    async (priorText) => {
      await save([turn('before-held-send', null, 'run tests', 150)])
      const { outcomes } = await recover('run tests', [submission('older', priorText, 100)])
      expect(outcomes?.find((outcome) => outcome.clientMessageId === 'held')).toMatchObject({
        outcome: 'unknown'
      })
    }
  )

  it('does not confirm an abandoned branch or text appearing only in a summary', async () => {
    await save([
      turn('root', null, 'hello', 105),
      turn('abandoned', 'root', 'run tests'),
      {
        type: 'branch_summary',
        id: 'branch',
        parentId: 'root',
        fromId: 'abandoned',
        summary: 'run tests',
        timestamp: new Date(220).toISOString()
      }
    ])
    expect((await recover()).outcomes).toMatchObject([{ outcome: 'unknown' }])
  })

  it('claims an accepted duplicate before offering the second stored copy', async () => {
    const accepted = [submission('first', 'run tests', 100, true)]
    await save([turn('first-copy', null, 'run tests', 205)])
    expect((await recover('run tests', accepted)).outcomes).toMatchObject([
      { clientMessageId: 'held', outcome: 'unknown' }
    ])
    await save([
      turn('first-copy', null, 'run tests', 205),
      turn('second-copy', 'first-copy', 'run tests', 210)
    ])
    expect((await recover('run tests', accepted)).outcomes).toMatchObject([
      { clientMessageId: 'held', outcome: 'accepted', providerItemId: 'second-copy' }
    ])
  })

  it('claims duplicate copies by their send times rather than active-branch traversal order', async () => {
    await save([
      turn('later-copy', null, 'run tests', 210),
      turn('earlier-copy', 'later-copy', 'run tests', 205)
    ])
    const { outcomes } = await recover('run tests', [submission('first', 'run tests', 100, true)])
    expect(outcomes).toMatchObject([
      { clientMessageId: 'held', outcome: 'accepted', providerItemId: 'later-copy' }
    ])
  })

  it('respects the captured active leaf of late usage rather than reviving an abandoned turn', async () => {
    await save([
      turn('root', null, 'hello', 105),
      turn('abandoned', 'root', 'run tests'),
      { type: 'custom', id: 'branch', parentId: 'root', customType: 'branch-marker' },
      { type: 'model_usage', id: 'usage', parentId: 'abandoned', activeLeafId: 'branch' }
    ])
    expect((await recover()).outcomes).toMatchObject([{ outcome: 'unknown' }])
  })

  it('does not guess an active branch when a late usage record names a missing leaf', async () => {
    await save([
      turn('delivered', null, 'run tests'),
      { type: 'model_usage', id: 'usage', parentId: 'delivered', activeLeafId: 'missing' }
    ])
    expect((await recover()).window).toBeNull()
  })

  it('honors an explicitly empty active branch instead of offering a saved abandoned turn', async () => {
    await save([
      turn('abandoned', null, 'run tests'),
      { type: 'model_usage', id: 'usage', parentId: 'abandoned', activeLeafId: null }
    ])
    expect((await recover()).outcomes).toMatchObject([{ outcome: 'unknown' }])
  })

  it('preserves whitespace and uses the earlier message time, not a delayed append time', async () => {
    const padded = turn('padded', null, ' run tests ', 205)
    await save([padded])
    expect((await recover()).outcomes).toMatchObject([{ outcome: 'unknown' }])
    expect((await recover(' run tests ')).outcomes).toMatchObject([{ outcome: 'accepted' }])
    const old = turn('old', null, 'run tests', 100)
    old.timestamp = new Date(205).toISOString()
    await save([old])
    expect((await recover()).outcomes).toMatchObject([{ outcome: 'unknown' }])
  })

  it.each(['partial', 'malformed', 'duplicate-id', 'missing-parent', 'wrong-session'])(
    'leaves incomplete or ambiguous %s evidence in doubt',
    async (kind) => {
      const records: unknown[] = [turn('delivered', null, 'run tests')]
      if (kind === 'duplicate-id') {
        records.push(turn('delivered', null, 'run tests'))
      }
      if (kind === 'missing-parent') {
        records.push(turn('broken', 'missing', 'run tests'))
      }
      if (kind === 'wrong-session') {
        records.unshift({ type: 'session', version: 3, id: 'other', cwd })
      }
      await save(records, {
        suffix: kind === 'partial' ? '' : kind === 'malformed' ? '\n{broken\n' : '\n'
      })
      expect((await recover()).window).toBeNull()
    }
  )

  it('does not use unreadable files, another cwd, or an ambiguous second matching file', async () => {
    expect((await recover()).window).toBeNull()
    await save([turn('foreign', null, 'run tests')], { bucket: '-other-project' })
    expect((await recover()).window).toBeNull()
    const path = await save([turn('delivered', null, 'run tests')])
    await save([turn('duplicate', null, 'run tests')], { file: `other_${PROVIDER}.jsonl` })
    expect((await recover()).window).toBeNull()
    await rm(path)
    await rm(join(agentRoot, 'sessions', '-project', `other_${PROVIDER}.jsonl`))
    await mkdir(path)
    expect((await recover()).window).toBeNull()
  })

  it('uses the pinned account root and profile rather than another account with the same session ID', async () => {
    await save([turn('wrong-account', null, 'run tests')], {
      dir: join(root, 'other-account', 'sessions')
    })
    expect((await recover()).window).toBeNull()
    await save([turn('account', null, 'run tests')])
    expect((await recover()).outcomes).toMatchObject([
      { providerItemId: 'account', outcome: 'accepted' }
    ])
    env.OMP_PROFILE = 'review'
    expect((await recover()).window).toBeNull()
    await save([turn('profile', null, 'run tests')], {
      dir: join(home, '.omp', 'profiles', 'review', 'agent', 'sessions')
    })
    expect((await recover()).outcomes).toMatchObject([
      { providerItemId: 'profile', outcome: 'accepted' }
    ])
  })

  it('honors a custom sessions root and rejects a colliding cwd bucket with a different header', async () => {
    await save([turn('ignored-account', null, 'run tests')])
    const custom = join(root, 'custom', 'sessions')
    env.OMP_CODING_AGENT_DIR = custom
    expect((await recover()).window).toBeNull()
    const path = await save([turn('custom', null, 'run tests')], { dir: custom })
    await mkdir(join(custom, '-project', FILE.slice(0, -'.jsonl'.length)))
    expect((await recover()).outcomes).toMatchObject([
      { outcome: 'accepted', providerItemId: 'custom' }
    ])
    await writeFile(
      path,
      `${[
        { type: 'session', version: 3, id: PROVIDER, cwd: join(home, 'other') },
        turn('foreign-cwd', null, 'run tests')
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
    )
    expect((await recover()).window).toBeNull()
  })

  it('refuses truncated text and mixed image evidence instead of confirming only the text', async () => {
    const mixed = {
      ...turn('mixed', null, 'run tests'),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'run tests' },
          { type: 'image', data: { blob: 'ref' } }
        ]
      }
    }
    await save([mixed])
    expect((await recover()).outcomes).toMatchObject([{ outcome: 'unknown' }])
    const text = 'run tests\n\n[Session persistence truncated large content]'
    await save([turn('truncated', null, text)])
    expect((await recover(text)).outcomes).toMatchObject([{ outcome: 'unknown' }])
  })

  it('does not use a file beyond the bounded recovery size', async () => {
    await save([
      turn('delivered', null, 'run tests'),
      { type: 'custom', id: 'large', parentId: 'delivered', padding: 'x'.repeat(16 * 1024 * 1024) }
    ])
    expect((await recover()).window).toBeNull()
  })

  it('does not use a record stream beyond the bounded recovery length', async () => {
    const records: unknown[] = [turn('delivered', null, 'run tests')]
    for (let index = 1; index < 100_000; index++) {
      records.push({ type: 'custom', id: `entry-${index}`, parentId: 'delivered' })
    }
    await save(records)
    expect((await recover()).window).toBeNull()
  })

  it('does not repair malformed UTF-8 into evidence for a replacement-character message', async () => {
    const path = await save([])
    const content = [
      { type: 'session', version: 3, id: PROVIDER, cwd },
      turn('invalid', null, 'run PLACEHOLDERtests')
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
    await writeFile(path, Buffer.from(`${content.replace('PLACEHOLDER', '\xff')}\n`, 'latin1'))
    expect((await recover('run \ufffdtests')).window).toBeNull()
  })

  it('reads a title-slot-prefixed session and honors cancellation without claiming delivery', async () => {
    const path = await save([turn('delivered', null, 'run tests')])
    await writeFile(
      path,
      `${[
        { type: 'title', v: 1, title: 'Saved', pad: '' },
        { type: 'session', version: 3, id: PROVIDER, cwd },
        turn('delivered', null, 'run tests')
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
    )
    expect((await recover()).outcomes).toMatchObject([{ outcome: 'accepted' }])
    expect(
      await ompStoredUserMessagesReader()({
        env,
        cwd,
        providerSessionId: PROVIDER,
        signal: AbortSignal.abort()
      })
    ).toBeNull()
  })
})
