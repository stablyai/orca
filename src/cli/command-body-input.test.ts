import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTextOrFileFlag } from './command-body-input'

const SPEC = 'Run `pnpm test` and say "done" when it\'s $HOME-free'

describe('readTextOrFileFlag', () => {
  let dir: string | undefined
  let restoreStdin: (() => void) | undefined

  afterEach(() => {
    restoreStdin?.()
    restoreStdin = undefined
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  it('reads the file relative to the caller cwd without shell interpretation', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-spec-file-'))
    writeFileSync(join(dir, 'spec.md'), SPEC)
    const flags = new Map<string, string | boolean>([['spec-file', 'spec.md']])
    await expect(readTextOrFileFlag(flags, dir, 'spec', true)).resolves.toBe(SPEC)
  })

  it('reads stdin for -', async () => {
    const stdin = process.stdin
    const previousIsTTY = stdin.isTTY
    Object.defineProperty(stdin, 'isTTY', { configurable: true, value: false })
    Object.defineProperty(stdin, Symbol.asyncIterator, {
      configurable: true,
      value: async function* () {
        yield SPEC
      }
    })
    restoreStdin = () => {
      Object.defineProperty(stdin, 'isTTY', { configurable: true, value: previousIsTTY })
      Reflect.deleteProperty(stdin, Symbol.asyncIterator)
    }
    const flags = new Map<string, string | boolean>([['spec-file', '-']])
    await expect(readTextOrFileFlag(flags, '/', 'spec', true)).resolves.toBe(SPEC)
  })

  it('refuses the text and file flags together', async () => {
    const flags = new Map<string, string | boolean>([
      ['spec', 'inline'],
      ['spec-file', 'spec.md']
    ])
    await expect(readTextOrFileFlag(flags, '/', 'spec', false)).rejects.toThrow(
      'Use either --spec or --spec-file, not both'
    )
  })
})
