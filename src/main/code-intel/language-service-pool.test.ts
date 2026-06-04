import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LanguageServicePool } from './language-service-pool'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-code-intel-pool-'))
  await mkdir(join(dir, 'src', 'prompts'), { recursive: true })
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, allowJs: true } }),
    'utf8'
  )
  await writeFile(
    join(dir, 'src', 'prompts', 'helpers.ts'),
    'export function composePrompt(): string {\n  return ""\n}\n',
    'utf8'
  )
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LanguageServicePool', () => {
  it('finds the nearest tsconfig and serves a language service for a file', () => {
    const pool = new LanguageServicePool({ maxServices: 3, idleMs: 60_000 })
    const entry = pool.acquire(join(dir, 'src', 'prompts', 'helpers.ts'))
    expect(entry).not.toBeNull()
    expect(entry!.projectRoot).toBe(dir)
    const sourceFile = entry!.service
      .getProgram()
      ?.getSourceFile(join(dir, 'src', 'prompts', 'helpers.ts'))
    expect(sourceFile).toBeDefined()
    pool.disposeAll()
  })

  it('returns null when no tsconfig is found', async () => {
    const orphan = await mkdtemp(join(tmpdir(), 'orca-code-intel-orphan-'))
    await writeFile(join(orphan, 'a.ts'), 'export const a = 1\n', 'utf8')
    const pool = new LanguageServicePool({ maxServices: 3, idleMs: 60_000 })
    expect(pool.acquire(join(orphan, 'a.ts'))).toBeNull()
    pool.disposeAll()
    await rm(orphan, { recursive: true, force: true })
  })

  it('overlays an in-memory buffer for one file over disk content', () => {
    const pool = new LanguageServicePool({ maxServices: 3, idleMs: 60_000 })
    const filePath = join(dir, 'src', 'prompts', 'helpers.ts')
    pool.setOverlay(filePath, 'export const FROM_BUFFER = 1\n', 2)
    const entry = pool.acquire(filePath)!
    const text = entry.service.getProgram()!.getSourceFile(filePath)!.getFullText()
    expect(text).toContain('FROM_BUFFER')
    pool.disposeAll()
  })

  it('clears the overlay so subsequent reads fall back to disk content', () => {
    const pool = new LanguageServicePool({ maxServices: 3, idleMs: 60_000 })
    const filePath = join(dir, 'src', 'prompts', 'helpers.ts')
    pool.setOverlay(filePath, 'export const FROM_BUFFER = 1\n', 2)
    pool.acquire(filePath)!.service.getProgram()!.getSourceFile(filePath)
    pool.clearOverlay()
    const text = pool
      .acquire(filePath)!
      .service.getProgram()!
      .getSourceFile(filePath)!
      .getFullText()
    expect(text).toContain('composePrompt')
    expect(text).not.toContain('FROM_BUFFER')
    pool.disposeAll()
  })

  it('evicts the least-recently-used service past the cap', () => {
    const pool = new LanguageServicePool({ maxServices: 1, idleMs: 60_000 })
    const a = pool.acquire(join(dir, 'src', 'prompts', 'helpers.ts'))!
    expect(pool.size()).toBe(1)
    // Same project root → still one service.
    pool.acquire(join(dir, 'src', 'prompts', 'helpers.ts'))
    expect(pool.size()).toBe(1)
    expect(a.projectRoot).toBe(dir)
    pool.disposeAll()
  })
})
