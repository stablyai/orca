import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { link } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { linkMissingCodexSessionRollouts } from '../rollouts/codex-session-link'
import { migrateLegacyCopiedCodexSessions } from './codex-session-bridge'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return { ...actual, link: vi.fn(actual.link) }
})

const ROLLOUT = join(
  '2026',
  '05',
  '26',
  'rollout-2026-05-26T10-00-00-019a0000-0000-7000-8000-00000000000a.jsonl'
)
let root = ''
let sourceHome = ''
let targetHome = ''

function writeFile(filePath: string, contents: string): string {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, contents)
  return filePath
}

function trySymlink(target: string, path: string): boolean {
  mkdirSync(dirname(path), { recursive: true })
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'file' : undefined)
    return true
  } catch (error) {
    // Windows without Developer Mode cannot create file symlinks.
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return false
    }
    throw error
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-session-bridge-'))
  sourceHome = join(root, 'system')
  targetHome = join(root, 'runtime')
})

afterEach(() => {
  vi.mocked(link).mockReset()
  rmSync(root, { recursive: true, force: true })
})

describe('linkMissingCodexSessionRollouts', () => {
  it('hardlinks missing rollouts and never overwrites a target-owned rollout', async () => {
    const source = writeFile(join(sourceHome, 'sessions', ROLLOUT), '{"id":"system"}\n')
    const otherName = ROLLOUT.replace('00000000000a', '00000000000b')
    writeFile(join(sourceHome, 'sessions', otherName), '{"id":"other"}\n')
    writeFile(join(targetHome, 'sessions', otherName), '{"id":"runtime"}\n')

    await linkMissingCodexSessionRollouts({
      sourceCodexHomePath: sourceHome,
      targetCodexHomePath: targetHome
    })

    const linked = join(targetHome, 'sessions', ROLLOUT)
    expect(statSync(linked).ino).toBe(statSync(source).ino)
    expect(readFileSync(join(targetHome, 'sessions', otherName), 'utf-8')).toBe(
      '{"id":"runtime"}\n'
    )
  })

  it('replaces a legacy symlinked rollout with a hardlink resume can read', async (ctx) => {
    const source = writeFile(join(sourceHome, 'sessions', ROLLOUT), '{"id":"system"}\n')
    const target = join(targetHome, 'sessions', ROLLOUT)
    if (!trySymlink(source, target)) {
      ctx.skip()
    }

    const pass = await linkMissingCodexSessionRollouts({
      sourceCodexHomePath: sourceHome,
      targetCodexHomePath: targetHome
    })

    expect(lstatSync(target).isSymbolicLink()).toBe(false)
    expect(statSync(target).ino).toBe(statSync(source).ino)
    expect([...pass.bridgedThreads.keys()]).toEqual(['019a0000-0000-7000-8000-00000000000a'])
  })

  it('leaves a symlink that points somewhere else untouched', async (ctx) => {
    writeFile(join(sourceHome, 'sessions', ROLLOUT), '{"id":"system"}\n')
    const elsewhere = writeFile(join(root, 'elsewhere.jsonl'), '{"id":"elsewhere"}\n')
    const target = join(targetHome, 'sessions', ROLLOUT)
    if (!trySymlink(elsewhere, target)) {
      ctx.skip()
    }

    await linkMissingCodexSessionRollouts({
      sourceCodexHomePath: sourceHome,
      targetCodexHomePath: targetHome
    })

    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf-8')).toBe('{"id":"elsewhere"}\n')
  })

  it('upgrades a symlink after a cross-volume link fails in another directory', async (ctx) => {
    writeFile(join(sourceHome, 'sessions', basename(ROLLOUT)), '{"id":"cross-volume"}\n')
    const source = writeFile(join(sourceHome, 'sessions', ROLLOUT), '{"turn":1}\n')
    const target = join(targetHome, 'sessions', ROLLOUT)
    if (!trySymlink(source, target)) {
      ctx.skip()
    }
    vi.mocked(link).mockRejectedValueOnce(
      Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
    )

    await linkMissingCodexSessionRollouts({
      sourceCodexHomePath: sourceHome,
      targetCodexHomePath: targetHome,
      hardlinkOnly: true
    })

    expect(lstatSync(target).isSymbolicLink()).toBe(false)
    appendFileSync(source, '{"turn":2}\n')
    expect(readFileSync(target, 'utf-8')).toBe('{"turn":1}\n{"turn":2}\n')
  })
})

describe('migrateLegacyCopiedCodexSessions', () => {
  function writeCopyMarker(source: string, target: string): string {
    const sourceStat = statSync(source)
    const targetStat = statSync(target)
    return writeFile(
      join(targetHome, '.orca-session-copies', `${ROLLOUT}.json`),
      JSON.stringify({
        sourcePath: source,
        sourceSize: sourceStat.size,
        sourceMtimeMs: sourceStat.mtimeMs,
        targetSize: targetStat.size,
        targetMtimeMs: targetStat.mtimeMs
      })
    )
  }

  it('relinks an unchanged copy to its grown source and clears its marker', async () => {
    const source = writeFile(join(sourceHome, 'sessions', ROLLOUT), '{"turn":1}\n')
    const target = join(targetHome, 'sessions', ROLLOUT)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    const marker = writeCopyMarker(source, target)
    appendFileSync(source, '{"turn":2}\n')

    expect(await migrateLegacyCopiedCodexSessions(targetHome)).toBe(1)

    expect(statSync(target).ino).toBe(statSync(source).ino)
    expect(readFileSync(target, 'utf-8')).toBe('{"turn":1}\n{"turn":2}\n')
    expect(existsSync(marker)).toBe(false)
  })

  it('keeps a copy Codex appended to, with its marker', async () => {
    const source = writeFile(join(sourceHome, 'sessions', ROLLOUT), '{"turn":1}\n')
    const target = join(targetHome, 'sessions', ROLLOUT)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    const marker = writeCopyMarker(source, target)
    appendFileSync(target, '{"turn":"runtime"}\n')

    expect(await migrateLegacyCopiedCodexSessions(targetHome)).toBe(0)

    expect(readFileSync(target, 'utf-8')).toBe('{"turn":1}\n{"turn":"runtime"}\n')
    expect(statSync(target).ino).not.toBe(statSync(source).ino)
    expect(existsSync(marker)).toBe(true)
  })
})
