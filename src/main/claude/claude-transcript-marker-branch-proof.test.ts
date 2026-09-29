// The branch rules a Claude transcript must satisfy, read off the marker tip. The live replay
// proves from the file tail instead and falls back to these rules when no tail row qualifies.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ClaudeTranscriptTailIncompleteError,
  proveClaudeTranscriptBranchFromJsonl
} from './claude-transcript-branch-proof'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

async function proveMarkerLeafUuid(
  transcriptPath: string,
  providerSessionId: string,
  previousLeafUuid: string | null = null
): Promise<string> {
  const contents = await readFile(transcriptPath, 'utf8')
  return proveClaudeTranscriptBranchFromJsonl({ contents, providerSessionId, previousLeafUuid })
    .leafUuid
}

describe('Claude transcript marker branch proof', () => {
  it('reads Claude last-prompt leaf metadata as the durable branch marker', async () => {
    const root = await makeRoot('orca-native-chat-resolve-claude-leaf-')
    const transcript = join(root, 'session.jsonl')
    await writeFile(
      transcript,
      [
        { type: 'user', uuid: 'leaf-old', parentUuid: null, sessionId: 'session-1' },
        {
          type: 'assistant',
          uuid: 'leaf-current',
          parentUuid: 'leaf-old',
          sessionId: 'session-1'
        },
        { type: 'last-prompt', leafUuid: 'leaf-current', sessionId: 'session-1' }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      'utf8'
    )

    await expect(proveMarkerLeafUuid(transcript, 'session-1', 'leaf-old')).resolves.toBe(
      'leaf-current'
    )
  })

  it('fails closed when a Claude transcript has no branch marker', async () => {
    const root = await makeRoot('orca-native-chat-resolve-claude-no-leaf-')
    const transcript = join(root, 'session.jsonl')
    await writeFile(
      transcript,
      '{"type":"assistant","uuid":"not-a-leaf","parentUuid":null,"sessionId":"session-1"}\n',
      'utf8'
    )

    await expect(proveMarkerLeafUuid(transcript, 'session-1')).rejects.toThrow(
      'missing last-prompt marker'
    )
  })

  it('distinguishes an incomplete final Claude JSONL record from durable malformed content', async () => {
    const root = await makeRoot('orca-native-chat-resolve-claude-torn-tail-')
    const transcript = join(root, 'session.jsonl')
    await writeFile(transcript, '{"type":"last-prompt"', 'utf8')

    await expect(proveMarkerLeafUuid(transcript, 'session-1')).rejects.toBeInstanceOf(
      ClaudeTranscriptTailIncompleteError
    )

    await writeFile(transcript, '{"type":"last-prompt"\n', 'utf8')
    await expect(proveMarkerLeafUuid(transcript, 'session-1')).rejects.not.toBeInstanceOf(
      ClaudeTranscriptTailIncompleteError
    )
  })

  it('refuses a Claude marker on a sibling branch', async () => {
    const root = await makeRoot('orca-native-chat-resolve-claude-sibling-')
    const transcript = join(root, 'session.jsonl')
    await writeFile(
      transcript,
      [
        { type: 'user', uuid: 'root', parentUuid: null, sessionId: 'session-1' },
        { type: 'assistant', uuid: 'expected', parentUuid: 'root', sessionId: 'session-1' },
        { type: 'system', uuid: 'sibling', parentUuid: 'root', sessionId: 'session-1' },
        { type: 'last-prompt', leafUuid: 'sibling', sessionId: 'session-1' }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      'utf8'
    )

    await expect(proveMarkerLeafUuid(transcript, 'session-1', 'expected')).rejects.toThrow(
      'sibling branch'
    )
  })

  it('refuses missing and cyclic Claude parent chains', async () => {
    const root = await makeRoot('orca-native-chat-resolve-claude-invalid-ancestry-')
    const missing = join(root, 'missing.jsonl')
    const cycle = join(root, 'cycle.jsonl')
    await writeFile(
      missing,
      [
        { type: 'user', uuid: 'expected', parentUuid: null, sessionId: 'session-1' },
        { type: 'assistant', uuid: 'leaf', parentUuid: 'absent', sessionId: 'session-1' },
        { type: 'last-prompt', leafUuid: 'leaf', sessionId: 'session-1' }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      'utf8'
    )
    await writeFile(
      cycle,
      [
        { type: 'user', uuid: 'expected', parentUuid: null, sessionId: 'session-1' },
        { type: 'assistant', uuid: 'left', parentUuid: 'right', sessionId: 'session-1' },
        { type: 'system', uuid: 'right', parentUuid: 'left', sessionId: 'session-1' },
        { type: 'last-prompt', leafUuid: 'right', sessionId: 'session-1' }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      'utf8'
    )

    await expect(proveMarkerLeafUuid(missing, 'session-1', 'expected')).rejects.toThrow(
      'missing ancestor absent'
    )
    await expect(proveMarkerLeafUuid(cycle, 'session-1', 'expected')).rejects.toThrow(
      'cycle in parentUuid ancestry'
    )
  })

  it('rejects non-transcript and sidechain UUIDs as the durable leaf', async () => {
    const root = await makeRoot('orca-native-chat-resolve-claude-leaf-filter-')
    const transcript = join(root, 'session.jsonl')
    await writeFile(
      transcript,
      [
        { type: 'user', uuid: 'main-user', parentUuid: null, sessionId: 'session-1' },
        {
          type: 'assistant',
          uuid: 'sidechain-assistant',
          parentUuid: 'main-user',
          sessionId: 'session-1',
          isSidechain: true
        },
        { type: 'result', uuid: 'result-frame', parentUuid: 'main-user', sessionId: 'session-1' },
        {
          type: 'system',
          subtype: 'init',
          uuid: 'init-frame',
          parentUuid: null,
          sessionId: 'session-1'
        },
        { type: 'stream_event', uuid: 'stream-frame', parentUuid: null, sessionId: 'session-1' },
        { type: 'last-prompt', leafUuid: 'sidechain-assistant', sessionId: 'session-1' }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      'utf8'
    )

    await expect(proveMarkerLeafUuid(transcript, 'session-1')).rejects.toThrow(
      'marker leaf is missing from the session graph'
    )
  })

  it('rejects a main leaf whose ancestry crosses a subagent sidechain', async () => {
    const root = await makeRoot('orca-native-chat-resolve-claude-sidechain-ancestry-')
    const transcript = join(root, 'session.jsonl')
    await writeFile(
      transcript,
      [
        { type: 'user', uuid: 'main-user', parentUuid: null, sessionId: 'session-1' },
        {
          type: 'assistant',
          uuid: 'sidechain-assistant',
          parentUuid: 'main-user',
          sessionId: 'session-1',
          isSidechain: true
        },
        {
          type: 'assistant',
          uuid: 'main-after-sidechain',
          parentUuid: 'sidechain-assistant',
          sessionId: 'session-1'
        },
        { type: 'last-prompt', leafUuid: 'main-after-sidechain', sessionId: 'session-1' }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      'utf8'
    )

    await expect(proveMarkerLeafUuid(transcript, 'session-1')).rejects.toThrow(
      'not on the main transcript'
    )
  })

  it('rejects a main leaf whose ancestry crosses a parent-tool-use sidechain', async () => {
    const root = await makeRoot('orca-native-chat-resolve-claude-parent-tool-ancestry-')
    const transcript = join(root, 'transcript.jsonl')
    await writeFile(
      transcript,
      [
        { type: 'user', uuid: 'main-user', parentUuid: null, sessionId: 'session-1' },
        {
          type: 'assistant',
          uuid: 'subagent-assistant',
          parentUuid: 'main-user',
          sessionId: 'session-1',
          parent_tool_use_id: 'tool-use-1'
        },
        {
          type: 'assistant',
          uuid: 'main-after-sidechain',
          parentUuid: 'subagent-assistant',
          sessionId: 'session-1'
        },
        { type: 'last-prompt', leafUuid: 'main-after-sidechain', sessionId: 'session-1' }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      'utf8'
    )

    await expect(proveMarkerLeafUuid(transcript, 'session-1')).rejects.toThrow(
      'not on the main transcript'
    )
  })

  it('rejects a previous cursor descended from a parent-tool-use sidechain', async () => {
    const root = await makeRoot('orca-native-chat-resolve-claude-parent-tool-cursor-')
    const transcript = join(root, 'transcript.jsonl')
    await writeFile(
      transcript,
      [
        { type: 'user', uuid: 'main-user', parentUuid: null, sessionId: 'session-1' },
        {
          type: 'assistant',
          uuid: 'subagent-assistant',
          parentUuid: 'main-user',
          sessionId: 'session-1',
          parent_tool_use_id: 'tool-use-1'
        },
        {
          type: 'assistant',
          uuid: 'main-after-sidechain',
          parentUuid: 'subagent-assistant',
          sessionId: 'session-1'
        },
        { type: 'last-prompt', leafUuid: 'main-after-sidechain', sessionId: 'session-1' }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      'utf8'
    )

    await expect(
      proveMarkerLeafUuid(transcript, 'session-1', 'main-after-sidechain')
    ).rejects.toThrow('not on the main transcript')
  })

  it('rejects a latest marker descended from a parent-tool-use cursor sidechain', async () => {
    const root = await makeRoot('orca-native-chat-resolve-claude-parent-tool-cursor-descendant-')
    const transcript = join(root, 'transcript.jsonl')
    await writeFile(
      transcript,
      [
        { type: 'user', uuid: 'main-user', parentUuid: null, sessionId: 'session-1' },
        {
          type: 'assistant',
          uuid: 'subagent-assistant',
          parentUuid: 'main-user',
          sessionId: 'session-1',
          parent_tool_use_id: 'tool-use-1'
        },
        {
          type: 'assistant',
          uuid: 'main-after-sidechain',
          parentUuid: 'subagent-assistant',
          sessionId: 'session-1'
        },
        {
          type: 'assistant',
          uuid: 'latest-after-sidechain',
          parentUuid: 'main-after-sidechain',
          sessionId: 'session-1'
        },
        { type: 'last-prompt', leafUuid: 'latest-after-sidechain', sessionId: 'session-1' }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      'utf8'
    )

    await expect(
      proveMarkerLeafUuid(transcript, 'session-1', 'main-after-sidechain')
    ).rejects.toThrow('not on the main transcript')
  })

  it('rejects a post-snapshot descendant whose parent row was observed later', async () => {
    const root = await makeRoot('orca-native-chat-resolve-claude-post-snapshot-')
    const transcript = join(root, 'transcript.jsonl')
    await writeFile(
      transcript,
      [
        {
          type: 'assistant',
          uuid: 'descendant',
          parentUuid: 'previous',
          sessionId: 'session-1'
        },
        { type: 'assistant', uuid: 'previous', parentUuid: null, sessionId: 'session-1' },
        { type: 'last-prompt', leafUuid: 'descendant', sessionId: 'session-1' }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      'utf8'
    )

    await expect(proveMarkerLeafUuid(transcript, 'session-1', 'previous')).rejects.toThrow(
      'parent row follows descendant'
    )
  })
})
