import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  VoiceControlTranscriptLog,
  readVoiceTranscriptLog,
  voiceControlTranscriptLogPath
} from './voice-control-transcript-log'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voice-transcript-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('VoiceControlTranscriptLog', () => {
  it('appends entries and reads them back in order', () => {
    const log = new VoiceControlTranscriptLog(voiceControlTranscriptLogPath(dir))
    log.append({ ts: 1, kind: 'user', text: 'clone the repo' })
    log.append({ ts: 2, kind: 'assistant', text: 'on it' })
    log.append({ ts: 3, kind: 'command', command: 'git status', cwd: '/tmp/x', output: 'clean' })
    log.append({ ts: 4, kind: 'update', spokenName: 'oak', text: 'done' })
    log.append({ ts: 5, kind: 'ui', summary: 'Clicked "Assigned to me".' })
    expect(log.read()).toEqual([
      { ts: 1, kind: 'user', text: 'clone the repo' },
      { ts: 2, kind: 'assistant', text: 'on it' },
      { ts: 3, kind: 'command', command: 'git status', cwd: '/tmp/x', output: 'clean' },
      { ts: 4, kind: 'update', spokenName: 'oak', text: 'done' },
      { ts: 5, kind: 'ui', summary: 'Clicked "Assigned to me".' }
    ])
  })

  it('reads an empty list when the file does not exist', () => {
    expect(readVoiceTranscriptLog(join(dir, 'nope', 'transcript.jsonl'))).toEqual([])
  })

  it('skips a torn tail line and keeps the rest', () => {
    const filePath = voiceControlTranscriptLogPath(dir)
    const log = new VoiceControlTranscriptLog(filePath)
    log.append({ ts: 1, kind: 'user', text: 'hello' })
    // A crash mid-append leaves a partial line; the read must survive it.
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}{"ts":2,"kind":"us`)
    expect(log.read()).toEqual([{ ts: 1, kind: 'user', text: 'hello' }])
  })

  it('skips lines that fail the entry shape guard', () => {
    const filePath = voiceControlTranscriptLogPath(dir)
    const log = new VoiceControlTranscriptLog(filePath)
    log.append({ ts: 1, kind: 'user', text: 'kept' })
    writeFileSync(
      filePath,
      `${readFileSync(filePath, 'utf8')}${JSON.stringify({ ts: 2, kind: 'bogus' })}\n${JSON.stringify({ kind: 'user' })}\n`
    )
    expect(log.read()).toEqual([{ ts: 1, kind: 'user', text: 'kept' }])
  })

  it('readback is bounded to the newest 200 entries', () => {
    const log = new VoiceControlTranscriptLog(voiceControlTranscriptLogPath(dir))
    for (let i = 0; i < 210; i++) {
      log.append({ ts: i, kind: 'user', text: `line ${i}` })
    }
    const read = log.read()
    expect(read).toHaveLength(200)
    expect(read.at(-1)).toEqual({ ts: 209, kind: 'user', text: 'line 209' })
  })

  it('rotates to .1 when the file exceeds the size cap and keeps appending', () => {
    const filePath = voiceControlTranscriptLogPath(dir)
    // Just over 1 MB of pre-existing log (e.g. left by the previous app run — the log
    // seeds its size on first append, so growth within a run is its own writes).
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, `${'x'.repeat(1024 * 1024 + 1)}\n`)
    const log = new VoiceControlTranscriptLog(filePath)
    log.append({ ts: 1, kind: 'user', text: 'after rotation' })
    expect(log.read()).toEqual([{ ts: 1, kind: 'user', text: 'after rotation' }])
    expect(statSync(`${filePath}.1`).size).toBeGreaterThan(1024 * 1024)
  })

  it('never throws when the directory is not writable', () => {
    const log = new VoiceControlTranscriptLog(join(dir, 'a-file-in-the-way', 'transcript.jsonl'))
    // Block mkdir by creating a file where the directory should be.
    writeFileSync(join(dir, 'a-file-in-the-way'), 'x')
    expect(() => log.append({ ts: 1, kind: 'user', text: 'ignored' })).not.toThrow()
    expect(log.read()).toEqual([])
  })
})
