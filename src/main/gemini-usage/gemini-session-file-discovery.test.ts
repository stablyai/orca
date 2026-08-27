import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listGeminiSessionFiles } from './gemini-session-file-discovery'

describe('gemini-session-file-discovery', () => {
  let testRoot: string
  let geminiTmpDir: string
  let antigravityBrainDir: string
  const originalGeminiSessionsDir = process.env.GEMINI_SESSIONS_DIR
  const originalAntigravityBrainDir = process.env.ANTIGRAVITY_BRAIN_DIR

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `orca-gemini-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    geminiTmpDir = join(testRoot, 'gemini-tmp')
    antigravityBrainDir = join(testRoot, 'antigravity-brain')

    process.env.GEMINI_SESSIONS_DIR = geminiTmpDir
    process.env.ANTIGRAVITY_BRAIN_DIR = antigravityBrainDir

    await mkdir(geminiTmpDir, { recursive: true })
    await mkdir(antigravityBrainDir, { recursive: true })
  })

  afterEach(async () => {
    if (originalGeminiSessionsDir !== undefined) {
      process.env.GEMINI_SESSIONS_DIR = originalGeminiSessionsDir
    } else {
      delete process.env.GEMINI_SESSIONS_DIR
    }

    if (originalAntigravityBrainDir !== undefined) {
      process.env.ANTIGRAVITY_BRAIN_DIR = originalAntigravityBrainDir
    } else {
      delete process.env.ANTIGRAVITY_BRAIN_DIR
    }

    await rm(testRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('discovers json and jsonl files in Gemini and Antigravity directories', async () => {
    // Write a Gemini session file in root
    await writeFile(join(geminiTmpDir, 'session-1.json'), '{}')
    // Write a Gemini session file in a subproject folder
    const subproject = join(geminiTmpDir, 'project-a')
    await mkdir(subproject, { recursive: true })
    await writeFile(join(subproject, 'session-2.jsonl'), '{}')

    // Write an Antigravity transcript
    const agyLogs = join(antigravityBrainDir, 'session-3', '.system_generated', 'logs')
    await mkdir(agyLogs, { recursive: true })
    await writeFile(join(agyLogs, 'transcript.jsonl'), '{}')

    // Write a non-session file that should be ignored
    await writeFile(join(antigravityBrainDir, 'history.jsonl'), '{}')
    await writeFile(join(geminiTmpDir, '.hidden.json'), '{}')

    const files = await listGeminiSessionFiles()
    expect(files).toHaveLength(3)
    expect(files.some((f) => f.includes('session-1.json'))).toBe(true)
    expect(files.some((f) => f.includes('session-2.jsonl'))).toBe(true)
    expect(files.some((f) => f.includes('transcript.jsonl'))).toBe(true)
  })

  it('returns empty list gracefully if directories do not exist', async () => {
    process.env.GEMINI_SESSIONS_DIR = join(testRoot, 'non-existent-gemini')
    process.env.ANTIGRAVITY_BRAIN_DIR = join(testRoot, 'non-existent-antigravity')

    const files = await listGeminiSessionFiles()
    expect(files).toEqual([])
  })
})
