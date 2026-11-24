import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Synthetic inputs keep disk-cost benchmarks reproducible without reading private transcripts.

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
  transcriptBytes: number
  messageCount: number
}

export type SyntheticCorpusOptions = {
  sessions?: number
  turnsPerSession?: number
  seed?: number
  /** Vary tool output’s share of message text when measuring index size. */
  toolResultWords?: number
}

export async function writeSyntheticTranscriptCorpus(
  options: SyntheticCorpusOptions = {}
): Promise<SyntheticCorpus> {
  const sessions = options.sessions ?? 40
  const turns = options.turnsPerSession ?? 60
  const toolWords = options.toolResultWords ?? 200
  for (const [name, value] of Object.entries({
    sessions,
    turnsPerSession: turns,
    toolResultWords: toolWords
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a finite non-negative safe integer`)
    }
  }
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
      // Empty tool results emit no searchable message.
      messageCount += toolWords === 0 ? 3 : 4
    }
    const path = join(root, `${sessionId}.jsonl`)
    const body = `${lines.join('\n')}\n`
    await writeFile(path, body)
    transcriptBytes += Buffer.byteLength(body)
    files.push(path)
  }

  return { root, files, transcriptBytes, messageCount }
}
