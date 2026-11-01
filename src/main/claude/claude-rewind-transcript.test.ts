import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { AgentSessionRewindRecordSchema } from '../../shared/agent-session-rewind'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { createClaudeStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { resolveClaudeRewindFork } from './claude-rewind-fork'
import { claudeSessionIdForRewind } from './structured/claude-structured-session-id'

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
  return readFile(new URL(`./__fixtures__/claude-rewind-${kind}.jsonl`, import.meta.url), 'utf8')
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
  it.each([
    { promptRow: 35, parentRow: 28, cursorRole: 'user' },
    { promptRow: 55, parentRow: 51, cursorRole: 'assistant' }
  ])(
    'keeps the exact $cursorRole cursor before recorded prompt $promptRow',
    async ({ promptRow, parentRow, cursorRole }) => {
      const prompt = sourceRows[promptRow - 1]
      const fork = await forkBefore(prompt.uuid)
      expect(fork).toMatchObject({
        materialized: true,
        sourceSessionId: source,
        throughEntryId: sourceRows[parentRow - 1].uuid
      })
      if (!fork) {
        throw new Error('fork missing')
      }
      const forkPath = join(project, `${fork.sessionId}.jsonl`)
      const contents = await readFile(forkPath, 'utf8')
      const conversation = (rows: typeof sourceRows) =>
        rows.filter((row) => row.type === 'user' || row.type === 'assistant')
      const kept = conversation(transcriptRows(contents))
      const expected = conversation(sourceRows.slice(0, parentRow))
      expect(kept.map((row) => row.forkedFrom.messageUuid)).toEqual(expected.map((row) => row.uuid))
      expect(kept.at(-1)).toMatchObject({ type: cursorRole, uuid: fork.resumeCursor })
      expect(fork.resumeCursor).toBeTruthy()
      expect(fork.resumeCursor).not.toBe(expected.at(-1)?.uuid)
      expect(contents).not.toContain(prompt.uuid)
      expect(await readFile(path, 'utf8')).toBe(original)
      expect((await readdir(project)).sort()).toEqual(
        [`${source}.jsonl`, `${fork.sessionId}.jsonl`].sort()
      )
      if (process.platform !== 'win32') {
        expect((await stat(forkPath)).mode & 0o777).toBe(0o600)
      }
    }
  )

  it.each(['hook', 'informational', 'null'] as const)(
    'starts and reloads an empty fork after a %s parent',
    async (kind) => {
      original = await recordedTranscript(kind === 'informational' ? 'informational' : 'hook')
      sourceRows = transcriptRows(original)
      const prompt = sourceRows.find((row) => row.type === 'user')
      if (kind === 'null') {
        prompt.parentUuid = null
        original = `${sourceRows.map((row) => JSON.stringify(row)).join('\n')}\n`
      }
      await writeFile(path, original)
      const operationId = randomUUID()
      const fork = await forkBefore(prompt.uuid, operationId)
      expect(fork).toStrictEqual({
        sessionId: claudeSessionIdForRewind('orca-chat', operationId),
        sourceSessionId: source,
        replacesSessionId: source,
        materialized: true
      })
      if (!fork) {
        throw new Error('fork missing')
      }
      expect(await readdir(project)).toEqual([`${source}.jsonl`])
      const launchers = [true, false].map((prepared) => {
        const handle = claudeProviderHandle(
          prepared ? source : fork.sessionId,
          prepared ? prompt.uuid : null
        )
        const record = agentSessionRecordFixture({
          sessionId: 'orca-chat',
          accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: home },
          providerHandleChain: [
            { linkId: 'head', origin: 'created', mintedAtFence: 1, observedAt: 1, handle }
          ],
          rewind: AgentSessionRewindRecordSchema.parse(
            JSON.parse(
              JSON.stringify({
                operationId,
                callerKey: 'desktop',
                itemId: 'item-1',
                expectedEpoch: 'epoch-1',
                phase: prepared ? 'prepared' : 'completed',
                providerFork: fork
              })
            )
          )
        })
        const resolve = createClaudeStructuredLaunchResolver({
          store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
          resolveLaunchArgs: () => [],
          resolveWorkspacePath: async () => project,
          resolveCommand: () => ({ command: '/usr/local/bin/claude', prefixArgs: [] }),
          resolveInheritedEnv: async () => ({ PATH: '/usr/bin' }),
          resolveAuthPolicy: () => ({ account: 'system' })
        })
        return () =>
          resolve({
            identity: {
              sessionId: record.sessionId,
              workspaceId: 'workspace-1',
              hostId: 'local',
              agent: 'claude',
              providerHandle: handle
            }
          })
      })
      for (const launch of launchers) {
        const fresh = await launch()
        expect(fresh.options.sessionId).toBe(fork.sessionId)
        expect(fresh.resumesTranscript).toBe(false)
        for (const key of ['resume', 'resumeSessionAt', 'forkSession']) {
          expect(fresh.options).not.toHaveProperty(key)
        }
      }
      await writeFile(
        join(project, `${fork.sessionId}.jsonl`),
        `${JSON.stringify({ ...prompt, sessionId: fork.sessionId, parentUuid: null })}\n`
      )
      for (const launch of launchers) {
        const resumed = await launch()
        expect(resumed.options.resume).toBe(fork.sessionId)
        expect(resumed.options).not.toHaveProperty('resumeSessionAt')
        expect(resumed.options).not.toHaveProperty('forkSession')
      }
      expect(await readFile(path, 'utf8')).toBe(original)
    }
  )

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
