import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./wsl', () => ({
  parseWslPath: vi.fn(() => null),
  toLinuxPath: vi.fn((value: string) => value)
}))

import { executeFormatCommand } from './format-on-save-process'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'format-on-save-injection-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

// Why: a filename comes from a cloned repository. Each name below would run a
// command or split into several arguments if a context were quoted wrongly.
const HOSTILE_NAMES = [
  'plain.ts',
  'a b.ts',
  "it's.ts",
  'say "hi".ts',
  '$(touch PWNED).ts',
  '`touch PWNED`.ts',
  'a;touch PWNED;b.ts',
  '"; touch PWNED; ".ts',
  "'; touch PWNED; '.ts",
  '$HOME.ts',
  '${file}.ts',
  'back\\slash.ts',
  'end\\',
  'new\nline.ts',
  '!bang.ts',
  '&&touch PWNED.ts'
]

// Each context wraps the token the way a user's own command might.
type QuotingContext = {
  name: string
  command: (out: string) => string
  wrap: (v: string) => string
}

const CONTEXTS: QuotingContext[] = [
  {
    name: 'unquoted',
    command: (out) => `printf %s ${'${file}'} > '${out}'`,
    wrap: (v) => v
  },
  {
    name: 'inside double quotes',
    command: (out) => `printf %s "pre-${'${file}'}-post" > '${out}'`,
    wrap: (v) => `pre-${v}-post`
  },
  {
    name: 'inside single quotes',
    command: (out) => `printf %s 'pre-${'${file}'}-post' > '${out}'`,
    wrap: (v) => `pre-${v}-post`
  },
  {
    name: 'inside command substitution inside double quotes',
    command: (out) => `printf %s "$(printf %s ${'${file}'})" > '${out}'`,
    wrap: (v) => v
  }
]

describe.skipIf(process.platform === 'win32')('format-on-save filename injection', () => {
  for (const context of CONTEXTS) {
    describe(context.name, () => {
      for (const name of HOSTILE_NAMES) {
        it(`passes ${JSON.stringify(name)} through verbatim`, async () => {
          const outFile = join(workDir, 'captured.txt')
          const absoluteFilePath = `${workDir}/${name}`

          const result = await executeFormatCommand({
            command: context.command(outFile),
            worktreePath: workDir,
            absoluteFilePath,
            relativePath: name
          })

          expect(result).toEqual({ status: 'completed' })
          expect(readFileSync(outFile, 'utf8')).toBe(context.wrap(absoluteFilePath))
          expect(existsSync(join(workDir, 'PWNED'))).toBe(false)
          expect(readdirSync(workDir)).toEqual(['captured.txt'])
        })
      }
    })
  }

  it('passes a dash-leading relative path as a path, not an option', async () => {
    const outFile = join(workDir, 'captured.txt')
    await executeFormatCommand({
      command: `printf %s ${'${relativeFile}'} > '${outFile}'`,
      worktreePath: workDir,
      absoluteFilePath: `${workDir}/--config=evil.js`,
      relativePath: '--config=evil.js'
    })

    expect(readFileSync(outFile, 'utf8')).toBe('./--config=evil.js')
  })

  it('reports a failure instead of running when a token sits where quoting is not modelled', async () => {
    const result = await executeFormatCommand({
      command: 'echo `cat ${file}`',
      worktreePath: workDir,
      absoluteFilePath: `${workDir}/a.ts`,
      relativePath: 'a.ts'
    })

    expect(result).toMatchObject({ status: 'failed' })
  })
})
