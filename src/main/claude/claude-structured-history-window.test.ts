// The Claude half of restart reconciliation: which transcript records become
// evidence, and when the read may be called boundary-consistent at all.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { structuredAgentSessionSendBody } from '../../shared/structured-agent-session-outbox'
import { structuredAgentSessionPayloadFingerprint } from '../../shared/structured-agent-session-mutation'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { reconcileSubmissions } from '../native-chat/agent-session-journal/journal-submission-reconciler'
import {
  claudeProviderHistoryWindowFromJsonl,
  resolveClaudeProviderHistoryWindow
} from './claude-structured-history-window'

const PROVIDER_SESSION = 'provider-1'
const ORCA_SESSION = 'session-1'

let accountHome: string

type Row = Record<string, unknown>

function prompt(uuid: string, parentUuid: string | null, content: unknown, extra: Row = {}): Row {
  return {
    type: 'user',
    uuid,
    parentUuid,
    sessionId: PROVIDER_SESSION,
    message: { role: 'user', content },
    ...extra
  }
}

function jsonl(rows: Row[], leafUuid: string): string {
  const lines = [...rows, { type: 'last-prompt', sessionId: PROVIDER_SESSION, leafUuid }]
  return `${lines.map((row) => JSON.stringify(row)).join('\n')}\n`
}

function read(contents: string, previousLeafUuid: string | null, turnInFlight = false) {
  return claudeProviderHistoryWindowFromJsonl({
    contents,
    providerSessionId: PROVIDER_SESSION,
    previousLeafUuid,
    sessionId: ORCA_SESSION,
    turnInFlight
  })
}

/** The digest the submission row carries for a plain typed send. */
function sendFingerprint(text: string): string {
  return structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: ORCA_SESSION,
    fields: { body: structuredAgentSessionSendBody(text, []) }
  })
}

const ANCHOR = prompt('anchor', null, 'earlier turn')

beforeEach(async () => {
  accountHome = await mkdtemp(join(tmpdir(), 'orca-claude-history-window-'))
})

afterEach(async () => {
  await rm(accountHome, { recursive: true, force: true })
})

describe('claudeProviderHistoryWindowFromJsonl', () => {
  it('resolves history from the session account home, not the process default', async () => {
    const transcriptPath = join(accountHome, 'projects', 'work', `${PROVIDER_SESSION}.jsonl`)
    await mkdir(join(accountHome, 'projects', 'work'), { recursive: true })
    await writeFile(
      transcriptPath,
      jsonl([ANCHOR, prompt('u-1', 'anchor', 'ship it')], 'u-1'),
      'utf8'
    )

    const window = await resolveClaudeProviderHistoryWindow({
      identity: {
        sessionId: ORCA_SESSION,
        workspaceId: 'workspace-1',
        hostId: 'host-1',
        agent: 'claude',
        providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION, leafUuid: 'anchor' }
      },
      accountHomePath: accountHome,
      hasLiveSession: false
    })

    expect(window?.items.map((item) => item.providerItemId)).toEqual(['u-1'])
  })

  it('pins the renderer and host fingerprint functions to the same digest', () => {
    // The renderer computes a send's fingerprint with one, the host admission gate
    // validates it with the other, and the window matches with the host's. A
    // divergence would refuse every send long before it reached here — but it
    // would also silently turn every reconciliation into `not_delivered`.
    const input = {
      method: 'agentSession.send',
      sessionId: ORCA_SESSION,
      fields: { body: structuredAgentSessionSendBody('ship it', []) }
    }

    expect(structuredAgentSessionPayloadFingerprint(input)).toBe(
      computeAgentSessionPayloadFingerprint(input)
    )
  })

  it('fingerprints a prompt after the anchor exactly as the send that produced it', () => {
    const contents = jsonl(
      [ANCHOR, prompt('u-1', 'anchor', [{ type: 'text', text: 'ship it' }])],
      'u-1'
    )

    const window = read(contents, 'anchor')

    expect(window.boundaryConsistent).toBe(true)
    expect(window.items).toEqual([
      {
        providerItemId: 'u-1',
        clientMessageId: null,
        payloadFingerprint: sendFingerprint('ship it'),
        identity: { provider: 'claude', sessionId: PROVIDER_SESSION, uuid: 'u-1' }
      }
    ])
  })

  it('fingerprints a string-content prompt the same as a block-content one', () => {
    const asString = read(jsonl([ANCHOR, prompt('u-1', 'anchor', 'ship it')], 'u-1'), 'anchor')

    expect(asString.items[0]?.payloadFingerprint).toBe(sendFingerprint('ship it'))
  })

  it('preserves leading whitespace when fingerprinting a text block', () => {
    const contents = jsonl(
      [ANCHOR, prompt('u-1', 'anchor', [{ type: 'text', text: '  ship it' }])],
      'u-1'
    )

    expect(read(contents, 'anchor').items[0]?.payloadFingerprint).toBe(sendFingerprint('  ship it'))
  })

  it('excludes everything before the anchor', () => {
    const contents = jsonl(
      [
        prompt('root', null, 'first'),
        prompt('anchor', 'root', 'second'),
        prompt('u-1', 'anchor', 'third')
      ],
      'u-1'
    )

    expect(read(contents, 'anchor').items.map((item) => item.providerItemId)).toEqual(['u-1'])
  })

  it('reports no window and an inconsistent boundary without a durable anchor', () => {
    const contents = jsonl([ANCHOR, prompt('u-1', 'anchor', 'ship it')], 'u-1')

    expect(read(contents, null)).toEqual({
      items: [],
      boundaryConsistent: false,
      turnInFlight: false
    })
  })

  it('reports an inconsistent boundary when the anchor is gone from the file', () => {
    // What a compaction or a fresh session file leaves behind.
    const contents = jsonl([prompt('u-1', null, 'ship it')], 'u-1')

    expect(read(contents, 'anchor').boundaryConsistent).toBe(false)
  })

  it('reports an inconsistent boundary when the leaf is on a sibling branch', () => {
    const contents = jsonl(
      [
        prompt('root', null, 'first'),
        prompt('anchor', 'root', 'second'),
        prompt('u-1', 'root', 'branched')
      ],
      'u-1'
    )

    expect(read(contents, 'anchor').boundaryConsistent).toBe(false)
  })

  it('reports an inconsistent boundary on a torn tail', () => {
    const contents = `${jsonl([ANCHOR, prompt('u-1', 'anchor', 'ship it')], 'u-1')}{"type":"user"`

    expect(read(contents, 'anchor').boundaryConsistent).toBe(false)
  })

  it('keeps the boundary consistent and the window empty when nothing followed the anchor', () => {
    expect(read(jsonl([ANCHOR], 'anchor'), 'anchor')).toEqual({
      items: [],
      boundaryConsistent: true,
      turnInFlight: false
    })
  })

  it('excludes harness-injected turns, meta turns, tool results and sidechains', () => {
    const contents = jsonl(
      [
        ANCHOR,
        prompt('u-reminder', 'anchor', [
          { type: 'text', text: '<system-reminder>be careful</system-reminder>' }
        ]),
        prompt('u-meta', 'u-reminder', [{ type: 'text', text: 'injected' }], { isMeta: true }),
        prompt('u-tool', 'u-meta', [{ type: 'tool_result', content: 'ok' }]),
        prompt('u-real', 'u-tool', 'ship it')
      ],
      'u-real'
    )

    expect(read(contents, 'anchor').items.map((item) => item.providerItemId)).toEqual(['u-real'])
  })

  it('excludes a prompt carrying an image, whose path the transcript does not keep', () => {
    const contents = jsonl(
      [
        ANCHOR,
        prompt('u-img', 'anchor', [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
        ])
      ],
      'u-img'
    )

    expect(read(contents, 'anchor').items).toEqual([])
    expect(read(contents, 'anchor').boundaryConsistent).toBe(true)
  })

  it('keeps the FIRST record for a repeated uuid, as the whole-file index did', () => {
    // An append-only transcript can repeat a uuid. Preferring the later copy
    // would silently swap one turn's evidence for another's.
    const contents = jsonl(
      [
        ANCHOR,
        prompt('u-1', 'anchor', 'first copy'),
        prompt('u-1', 'anchor', 'second copy'),
        prompt('u-2', 'u-1', 'next')
      ],
      'u-2'
    )

    expect(read(contents, 'anchor').items[0]?.payloadFingerprint).toBe(
      sendFingerprint('first copy')
    )
  })

  it('drops a repeated uuid whose first copy is not a prompt', () => {
    // The de-dupe runs BEFORE the prompt filter, so a later prompt-shaped copy
    // cannot promote a uuid the index had already resolved to a non-prompt.
    const contents = jsonl(
      [
        ANCHOR,
        prompt('u-1', 'anchor', 'injected', { isMeta: true }),
        prompt('u-1', 'anchor', 'real prompt')
      ],
      'u-1'
    )

    expect(read(contents, 'anchor').items).toEqual([])
    expect(read(contents, 'anchor').boundaryConsistent).toBe(true)
  })

  it('refuses a malformed line rather than skipping past it into the window', () => {
    // The branch proof runs first and throws on any unparseable record; the
    // replay that follows only tolerates them because that pass already ran.
    const contents = jsonl([ANCHOR, prompt('u-1', 'anchor', 'ship it')], 'u-1').replace(
      '{"type":"last-prompt"',
      'not json\n{"type":"last-prompt"'
    )

    expect(read(contents, 'anchor').boundaryConsistent).toBe(false)
  })

  it('carries the caller-proven turn-in-flight fact through to the window', () => {
    const contents = jsonl([ANCHOR, prompt('u-1', 'anchor', 'ship it')], 'u-1')

    expect(read(contents, 'anchor', true).turnInFlight).toBe(true)
  })
})

describe('a crash between Claude saving a prompt and Orca recording its echo', () => {
  const row = (type: string, uuid: string, parentUuid: string | null, extra: Row = {}): Row => ({
    type,
    uuid,
    parentUuid,
    isSidechain: false,
    sessionId: PROVIDER_SESSION,
    ...extra
  })
  const marker = (leafUuid: string): Row => ({
    type: 'last-prompt',
    sessionId: PROVIDER_SESSION,
    leafUuid
  })
  const side = (type: string): Row => ({ type, sessionId: PROVIDER_SESSION })
  // Shaped like a real 2.1.280 transcript: after a turn, Claude's marker names its stop-hook
  // summary, and a crash mid-turn leaves the next prompt after the marker with no newer marker.
  const CRASHED_MID_TURN = [
    side('queue-operation'),
    row('attachment', 'hook-start', null, { attachment: { type: 'hook_success' } }),
    prompt('alpha', 'hook-start', [{ type: 'text', text: 'ALPHA' }]),
    row('attachment', 'alpha-context', 'alpha', { attachment: { type: 'date' } }),
    marker('alpha-context'),
    side('ai-title'),
    row('assistant', 'alpha-reply', 'alpha-context', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'ALPHA' }] }
    }),
    row('attachment', 'alpha-hook', 'alpha-reply', { attachment: { type: 'hook_success' } }),
    row('system', 'alpha-stop-summary', 'alpha-hook', { subtype: 'stop_hook_summary' }),
    marker('alpha-stop-summary'),
    side('queue-operation'),
    prompt('bravo', 'alpha-stop-summary', [{ type: 'text', text: 'BRAVO' }])
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n')

  it('reconciles the prompt Claude already holds as accepted, not undelivered', () => {
    // The durable anchor is Orca's last completed turn: the reply it saw on the live stream.
    const window = read(`${CRASHED_MID_TURN}\n`, 'alpha-reply')
    expect(window).toMatchObject({ boundaryConsistent: true })
    expect(window.items.map((item) => item.providerItemId)).toEqual(['bravo'])

    const [verdict] = reconcileSubmissions({
      history: window,
      submissions: [
        {
          clientMessageId: 'bravo-send',
          fence: 1,
          payloadFingerprint: sendFingerprint('BRAVO'),
          dispatchState: 'unknown',
          providerItemId: null,
          reason: null,
          submittedAt: 0,
          resolvedAt: null
        }
      ]
    })
    expect(verdict).toMatchObject({ clientMessageId: 'bravo-send', outcome: 'accepted' })
  })

  it('ends the conversation at the last main-chain row, never a trailing sidechain row', () => {
    const subagent = row('assistant', 'subagent-reply', null, { isSidechain: true })
    const window = read(`${CRASHED_MID_TURN}\n${JSON.stringify(subagent)}\n`, 'alpha-reply')
    expect(window.items.map((item) => item.providerItemId)).toEqual(['bravo'])
  })
})
