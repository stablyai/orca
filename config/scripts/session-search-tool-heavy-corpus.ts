import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The corpus the scope benchmark runs over. Written here rather than by
// `session-search-synthetic-corpus.ts` because what it costs to answer a
// conversation query out of the one FTS table turns on the property that
// generator fixes: how much of a transcript is tool output.
//
// Synthetic, always. This must never be pointed at a real transcript.

const PROSE = [
  'terminal',
  'reattach',
  'worktree',
  'the',
  'index',
  'cursor',
  'publish',
  'transaction',
  'relay',
  'daemon',
  'snapshot',
  'because',
  'stale',
  'session'
]
// Tool output is paths, hashes and log lines — and the same words the
// conversation uses, because a `rg` over this repository prints them. That
// overlap is what the benchmark turns on: it is what makes a conversation
// term's posting list carry rows the column filter then has to discard. A tool
// vocabulary disjoint from the prose would leave nothing to discard and measure
// the wrong thing.
const TOOL_ONLY = [
  'src/main/ai-vault/session-transcript-reader.ts',
  'node_modules/.pnpm/typescript@5.9.2',
  '0x00007ff8',
  'ENOENT',
  'drwxr-xr-x',
  '2026-09-10T00:00:00.000Z',
  'sha256:9f2c1a',
  'chunk-VHQ4NWQK.js',
  'warning:',
  'resolveTerminalPath',
  'byteOffset',
  'MAX_RETRIES'
]
// Half the tool tokens are conversation words. Deliberately pessimistic: the
// more of a query term lives in `tool_text`, the more the column filter costs,
// so a number measured here holds on a real transcript tree.
const TOOL = [...PROSE, ...TOOL_ONLY]

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function words(random: () => number, vocabulary: readonly string[], count: number): string {
  const out: string[] = []
  for (let index = 0; index < count; index++) {
    out.push(vocabulary[Math.floor(random() * vocabulary.length)]!)
  }
  return out.join(' ')
}

export type ToolHeavyCorpus = {
  root: string
  files: string[]
  transcriptBytes: number
  toolBytes: number
  proseBytes: number
}

/**
 * Claude JSONL transcripts whose tool output is `toolShare` of the message text.
 * One turn is a user question, an assistant answer, a tool call and its output;
 * only the last one grows with the share.
 */
export async function writeToolHeavyCorpus(args: {
  targetBytes: number
  toolShare: number
  seed?: number
}): Promise<ToolHeavyCorpus> {
  const random = mulberry32(args.seed ?? 11)
  const root = await mkdtemp(join(tmpdir(), 'orca-search-convfts-'))
  const files: string[] = []
  const proseWordsPerTurn = 160
  // Tool and prose words are not the same length, so the share is over bytes.
  const proseBytesPerTurn = proseWordsPerTurn * 6
  const toolWordCount = Math.max(
    1,
    Math.round((proseBytesPerTurn * args.toolShare) / (1 - args.toolShare) / 22)
  )
  let transcriptBytes = 0
  let toolBytes = 0
  let proseBytes = 0
  for (let session = 0; transcriptBytes < args.targetBytes; session++) {
    const sessionId = `00000000-0000-4000-8000-${String(session).padStart(12, '0')}`
    const lines: string[] = []
    for (let turn = 0; turn < 40; turn++) {
      const at = new Date(1740000000000 + turn * 60_000).toISOString()
      const question = words(random, PROSE, 40)
      const answer = words(random, PROSE, proseWordsPerTurn - 40)
      const output = words(random, TOOL, toolWordCount)
      proseBytes += Buffer.byteLength(question) + Buffer.byteLength(answer)
      toolBytes += Buffer.byteLength(output)
      lines.push(
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: at,
          cwd: `/repo/app-${session % 7}`,
          gitBranch: 'main',
          message: { role: 'user', content: question }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId,
          timestamp: at,
          message: {
            role: 'assistant',
            model: 'claude-fable-5',
            content: [
              { type: 'text', text: answer },
              { type: 'tool_use', name: 'Bash', input: { command: 'rg needle' } }
            ]
          }
        }),
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: at,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: output }]
          }
        })
      )
    }
    const path = join(root, `${sessionId}.jsonl`)
    const body = `${lines.join('\n')}\n`
    await writeFile(path, body)
    transcriptBytes += Buffer.byteLength(body)
    files.push(path)
  }
  return { root, files, transcriptBytes, toolBytes, proseBytes }
}
