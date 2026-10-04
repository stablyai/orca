import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnBundledRipgrep } from './bundled-ripgrep-spawn'
import {
  buildRgArgs,
  createAccumulator,
  finalize,
  ingestRgJsonLine
} from '../../shared/text-search'

describe('ripgrep Unicode match coordinates', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-rg-unicode-'))
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  async function search(
    query: string,
    useRegex = false,
    includePattern?: string,
    excludePattern?: string
  ) {
    const child = spawnBundledRipgrep(
      buildRgArgs(query, '.', { useRegex, includePattern, excludePattern }),
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let output = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr?.resume()
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) =>
        code === 0 || code === 1 ? resolve() : reject(new Error(`rg exit ${code}`))
      )
    })
    const acc = createAccumulator()
    for (const line of output.split('\n')) {
      ingestRgJsonLine(line, root, acc, 2000)
    }
    return finalize(acc)
  }

  it('uses UTF16 columns and lengths for multibyte prefixes and astral matches', async () => {
    await writeFile(join(root, 'example.txt'), '😀 café 日本 needle 😀 needle\r\n')
    const result = await search('needle|😀', true)
    expect(
      result.files[0]?.matches.map(({ column, matchLength }) => [column, matchLength])
    ).toEqual([
      [1, 2],
      [12, 6],
      [19, 2],
      [22, 6]
    ])
  })

  it.each(['src/**', '/src/**'])('honors root-relative include glob %s', async (includePattern) => {
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'other'))
    await writeFile(join(root, 'src', 'match.txt'), 'needle')
    await writeFile(join(root, 'src', 'skip.txt'), 'needle')
    await writeFile(join(root, 'other', 'match.txt'), 'needle')
    const result = await search('needle', false, includePattern, '/src/skip.txt')
    expect(result.files.map((file) => [file.filePath, file.relativePath])).toEqual([
      [join(root, 'src', 'match.txt'), 'src/match.txt']
    ])
  })

  it('keeps navigation and clamped display coordinates aligned', async () => {
    const prefix = '日本😀'.repeat(200)
    await writeFile(join(root, 'long.txt'), `${prefix}needle`)
    const match = (await search('needle')).files[0]?.matches[0]
    expect(match?.column).toBe(prefix.length + 1)
    expect(
      match?.lineContent.slice(
        (match.displayColumn ?? 1) - 1,
        (match.displayColumn ?? 1) - 1 + match.matchLength
      )
    ).toBe('needle')
  })

  it('decodes malformed UTF8 context and maps matches using the original bytes', async () => {
    const bytes = Buffer.concat([
      Buffer.from('😀 '),
      Buffer.from([0xe2, 0x82, 0xff]),
      Buffer.from(' needle é needle\r\n')
    ])
    await writeFile(join(root, 'malformed.txt'), bytes)
    const content = bytes.toString('utf8').replace(/\n$/, '')
    const result = await search('needle')
    expect(result.totalMatches).toBe(2)
    expect(
      result.files[0]?.matches.map((match) => [match.column, match.matchLength, match.lineContent])
    ).toEqual([
      [content.indexOf('needle') + 1, 6, content],
      [content.lastIndexOf('needle') + 1, 6, content]
    ])
    expect(result.truncated).toBe(false)
  })

  it('ignores external rg config while retaining workspace ignore files', async () => {
    const config = join(root, 'config')
    await writeFile(config, '--invert-match\n')
    vi.stubEnv('RIPGREP_CONFIG_PATH', config)
    await writeFile(join(root, '.ignore'), 'ignored.txt\n')
    await writeFile(join(root, 'ignored.txt'), 'needle\n')
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'visible.txt'), 'needle\nother\n')
    const result = await search('needle')
    expect(result.files.map((file) => file.relativePath)).toEqual(['docs/visible.txt'])
    expect(result.files[0]?.matches[0]?.lineContent).toBe('needle')
  })
})
