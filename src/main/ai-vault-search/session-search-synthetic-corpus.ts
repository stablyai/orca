import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Why synthetic and in-repo: the cost model has to be reproducible on any host
// and must never read a real transcript. The shapes here mirror what a Claude
// JSONL transcript actually holds — prose turns, a pasted diff, tool calls and
// their output — because the index's disk cost tracks the mix, not the size.

const WORDS = [
  'terminal',
  'reattach',
  'worktree',
  'resolveTerminalPath',
  'src/main/ai-vault/session-transcript-reader.ts',
  'the',
  'index',
  'cursor',
  'byteOffset',
  'publish',
  'staged',
  'transaction',
  'MAX_RETRIES',
  'relay',
  'daemon',
  'pty',
  'snapshot',
  'because'
]

/** Deterministic: the same seed gives the same corpus on every host and run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function words(random: () => number, count: number): string {
  const out: string[] = []
  for (let index = 0; index < count; index++) {
    out.push(WORDS[Math.floor(random() * WORDS.length)])
  }
  return out.join(' ')
}

export type SyntheticCorpus = {
  root: string
  files: string[]
  /** Total bytes of transcript written, the denominator of write amplification. */
  transcriptBytes: number
  messageCount: number
}

export type SyntheticCorpusOptions = {
  sessions?: number
  turnsPerSession?: number
  seed?: number
  /**
   * Words per tool result. The default keeps tool output at about half the
   * message text; the real distribution is 80-97 %, which is what prices the
   * tool-row cap, so the benchmark runs a second arm well above the default.
   */
  toolResultWords?: number
}

/** Writes a corpus of Claude JSONL transcripts and reports what it cost on disk. */
export async function writeSyntheticTranscriptCorpus(
  options: SyntheticCorpusOptions = {}
): Promise<SyntheticCorpus> {
  const sessions = options.sessions ?? 40
  const turns = options.turnsPerSession ?? 60
  const toolWords = options.toolResultWords ?? 200
  const random = mulberry32(options.seed ?? 1)
  const root = await mkdtemp(join(tmpdir(), 'orca-search-corpus-'))
  const files: string[] = []
  let transcriptBytes = 0
  let messageCount = 0

  for (let session = 0; session < sessions; session++) {
    const sessionId = `00000000-0000-4000-8000-${String(session).padStart(12, '0')}`
    const lines: string[] = []
    for (let turn = 0; turn < turns; turn++) {
      const at = new Date(1740000000000 + turn * 60_000).toISOString()
      lines.push(
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: at,
          cwd: `/repo/app-${session % 7}`,
          gitBranch: 'main',
          message: { role: 'user', content: words(random, 40) }
        })
      )
      lines.push(
        JSON.stringify({
          type: 'assistant',
          sessionId,
          timestamp: at,
          message: {
            role: 'assistant',
            model: 'claude-fable-5',
            content: [
              { type: 'text', text: words(random, 120) },
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: `rg ${words(random, 3)}` }
              }
            ]
          }
        })
      )
      lines.push(
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: at,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: words(random, toolWords)
              }
            ]
          }
        })
      )
      // One user turn, one assistant turn, one tool call, one tool result.
      messageCount += 4
    }
    const path = join(root, `${sessionId}.jsonl`)
    const body = `${lines.join('\n')}\n`
    await writeFile(path, body)
    transcriptBytes += Buffer.byteLength(body)
    files.push(path)
  }

  return { root, files, transcriptBytes, messageCount }
}
