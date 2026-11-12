import './claude-conversation-worker.test-fixture'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

import { resolveClaudeRewindFork } from './claude-rewind-fork'

let root: string
let home: string
let project: string
let source: string
let path: string
let original: string
let sourceRows: ReturnType<typeof transcriptRows>

function transcriptRows(contents: string) {
  return contents
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

async function recordedTranscript(kind: 'hook' | 'informational') {
  return readFile(new URL(`../__fixtures__/claude-rewind-${kind}.jsonl`, import.meta.url), 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-rewind-transcript-'))
  home = join(root, 'account')
  project = join(home, 'projects', 'workspace')
  await mkdir(project, { recursive: true })
  original = await recordedTranscript('hook')
  sourceRows = transcriptRows(original)
  source = sourceRows[6].sessionId
  path = join(project, `${source}.jsonl`)
  await writeFile(path, original)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function forkBefore(uuid: string, rewindOperationId = randomUUID()) {
  return resolveClaudeRewindFork({
    orcaSessionId: 'orca-chat',
    rewindOperationId,
    head: claudeProviderHandle(source, sourceRows.at(-1)?.uuid),
    prompt: { sessionId: source, uuid },
    claudeConfigDirs: [join(root, 'other-account'), home]
  })
}

describe('durable Claude rewind transcripts', () => {
  it('drops the local-command caveat when rewinding to a local command', async () => {
    const turn = sourceRows[50]
    const row = (uuid: string, parentUuid: string, content: string, isMeta?: true) => ({
      ...sourceRows[54],
      uuid,
      parentUuid,
      isMeta,
      message: { role: 'user', content }
    })
    const caveat = row(
      randomUUID(),
      turn.uuid,
      '<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>',
      true
    )
    const command = row(randomUUID(), caveat.uuid, '<command-name>/usage</command-name>')
    const stdout = row(
      randomUUID(),
      command.uuid,
      '<local-command-stdout>ok</local-command-stdout>'
    )
    await writeFile(
      path,
      `${[...sourceRows.slice(0, 54), caveat, command, stdout].map((r) => JSON.stringify(r)).join('\n')}\n`
    )
    const fork = await forkBefore(command.uuid)
    expect(fork).toMatchObject({ materialized: true, throughEntryId: turn.uuid })
    const contents = await readFile(join(project, `${fork?.sessionId}.jsonl`), 'utf8')
    expect(contents).not.toContain('local-command-caveat')
  })

  it('skips a torn transcript line instead of failing the rewind', async () => {
    const damaged = `{broken-json}\n${original}{"type":`
    await writeFile(path, damaged)
    const fork = await forkBefore(sourceRows[34].uuid)
    expect(fork).toMatchObject({ materialized: true, throughEntryId: sourceRows[27].uuid })
    const contents = await readFile(join(project, `${fork?.sessionId}.jsonl`), 'utf8')
    expect(contents).not.toContain(sourceRows[34].uuid)
    expect(await readFile(path, 'utf8')).toBe(damaged)
  })
})
