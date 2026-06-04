import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LanguageServicePool } from './language-service-pool'
import { getDefinition, findReferences } from './navigation'

let dir: string
let pool: LanguageServicePool

const HELPERS = `export type PromptParts = { header: string; body: string }

export function composePrompt(
  parts: PromptParts,
  options?: { includeFooter?: boolean }
): string {
  const footer = options?.includeFooter ? "\\n--- end ---" : ""
  return \`\${parts.header}\\n\\n\${parts.body}\${footer}\`
}
`

const BUILD_REQUEST = `import { composePrompt, type PromptParts } from "./prompts/helpers"

export function buildUserFacingText(parts: PromptParts): string {
  return composePrompt(parts, { includeFooter: true })
}
`

const DETAIL = `// Footer handling lives at the composePrompt layer for consistency across routes.
export function buildDetail(): string {
  return "{}"
}
`

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-code-intel-nav-'))
  await mkdir(join(dir, 'src', 'prompts'), { recursive: true })
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true } }),
    'utf8'
  )
  await writeFile(join(dir, 'src', 'prompts', 'helpers.ts'), HELPERS, 'utf8')
  await writeFile(join(dir, 'src', 'build-request.ts'), BUILD_REQUEST, 'utf8')
  await writeFile(join(dir, 'src', 'prompts', 'detail.ts'), DETAIL, 'utf8')
  pool = new LanguageServicePool({ maxServices: 3, idleMs: 60_000 })
})

afterEach(async () => {
  pool.disposeAll()
  await rm(dir, { recursive: true, force: true })
})

const COMPOSE_DEF_POS = { line: 2, character: 16 }

describe('navigation (#961 fixture)', () => {
  it('Find References lists the real call site and excludes the comment-only mention', () => {
    const result = findReferences(pool, {
      filePath: join(dir, 'src', 'prompts', 'helpers.ts'),
      relativePath: 'src/prompts/helpers.ts',
      position: COMPOSE_DEF_POS,
      bufferVersion: 0
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') {
      return
    }
    const refPaths = result.locations.map((l) => l.relativePath).sort()
    // build-request.ts is a real reference; helpers.ts is the declaration itself.
    expect(refPaths).toContain('src/build-request.ts')
    // The comment-only mention in detail.ts must NOT appear.
    expect(refPaths).not.toContain('src/prompts/detail.ts')
  })

  it('Go to Definition from the call site jumps to helpers.ts', () => {
    // In build-request.ts, `composePrompt(parts, ...)` call is on line index 3.
    // Character of the `composePrompt` call identifier = 9.
    const result = getDefinition(pool, {
      filePath: join(dir, 'src', 'build-request.ts'),
      relativePath: 'src/build-request.ts',
      position: { line: 3, character: 9 },
      bufferVersion: 0
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') {
      return
    }
    expect(result.locations.map((l) => l.relativePath)).toContain('src/prompts/helpers.ts')
    // The absolute path lets the renderer open the file without reconstructing
    // it from a worktree root that may differ from the project root.
    expect(result.locations.map((l) => l.absolutePath)).toContain(
      join(dir, 'src', 'prompts', 'helpers.ts')
    )
  })

  it('returns unsupported:no-tsconfig for a file outside any project', async () => {
    const orphan = await mkdtemp(join(tmpdir(), 'orca-code-intel-orphan2-'))
    await writeFile(join(orphan, 'x.ts'), 'export const x = 1\n', 'utf8')
    const result = getDefinition(pool, {
      filePath: join(orphan, 'x.ts'),
      relativePath: 'x.ts',
      position: { line: 0, character: 13 },
      bufferVersion: 0
    })
    expect(result).toEqual({ status: 'unsupported', reason: 'no-tsconfig' })
    await rm(orphan, { recursive: true, force: true })
  })
})
