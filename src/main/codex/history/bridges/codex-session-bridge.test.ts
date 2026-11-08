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
      sourceCodexHomePaths: [sourceHome],
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
      sourceCodexHomePaths: [sourceHome],
      targetCodexHomePath: targetHome,
      collectThreads: true
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
      sourceCodexHomePaths: [sourceHome],
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
      sourceCodexHomePaths: [sourceHome],
      targetCodexHomePath: targetHome,
      hardlinkOnly: true
    })

    expect(lstatSync(target).isSymbolicLink()).toBe(false)
    appendFileSync(source, '{"turn":2}\n')
    expect(readFileSync(target, 'utf-8')).toBe('{"turn":1}\n{"turn":2}\n')
  })
})

describe('linkMissingCodexSessionRollouts across sources', () => {
  function rolloutName(index: number): string {
    return `rollout-2026-05-26T10-00-00-019a0000-0000-7000-8000-${String(index).padStart(12, '0')}.jsonl`
  }

  it('prefers the first source holding a rollout and fills the rest from later ones', async () => {
    const accountHome = join(root, 'account')
    const day = join('2026', '05', '26')
    for (let index = 0; index < 3; index += 1) {
      writeFile(join(sourceHome, 'sessions', day, rolloutName(index)), `{"system":${index}}\n`)
    }
    writeFile(join(accountHome, 'sessions', day, rolloutName(0)), '{"account":0}\n')
    writeFile(join(accountHome, 'sessions', day, rolloutName(99)), '{"account":99}\n')
    writeFile(join(targetHome, 'sessions', day, rolloutName(1)), '{"runtime":1}\n')

    await linkMissingCodexSessionRollouts({
      sourceCodexHomePaths: [sourceHome, accountHome],
      targetCodexHomePath: targetHome
    })

    const target = (index: number) => join(targetHome, 'sessions', day, rolloutName(index))
    expect(readFileSync(target(0), 'utf-8')).toBe('{"system":0}\n')
    expect(readFileSync(target(1), 'utf-8')).toBe('{"runtime":1}\n')
    expect(readFileSync(target(2), 'utf-8')).toBe('{"system":2}\n')
    expect(readFileSync(target(99), 'utf-8')).toBe('{"account":99}\n')
  })

  it('keeps cross-volume symlinks and upgrades them once hardlinks become possible', async (ctx) => {
    const day = join('2026', '05', '26')
    const sources = [0, 1, 2].map((index) =>
      writeFile(join(sourceHome, 'sessions', day, rolloutName(index)), `{"turn":${index}}\n`)
    )
    const targets = [0, 1, 2].map((index) => join(targetHome, 'sessions', day, rolloutName(index)))
    if (!sources.every((source, index) => trySymlink(source, targets[index]))) {
      ctx.skip()
    }
    vi.mocked(link).mockRejectedValue(
      Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
    )
    const pass = () =>
      linkMissingCodexSessionRollouts({
        sourceCodexHomePaths: [sourceHome],
        targetCodexHomePath: targetHome
      })

    await pass()
    expect(targets.every((target) => lstatSync(target).isSymbolicLink())).toBe(true)

    vi.mocked(link).mockReset()
    vi.mocked(link).mockImplementation(async (...args) => {
      const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
      return actual.link(...args)
    })
    await pass()
    expect(targets.some((target) => lstatSync(target).isSymbolicLink())).toBe(false)
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

    expect(await migrateLegacyCopiedCodexSessions(targetHome, sourceHome)).toBe(1)

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

    expect(await migrateLegacyCopiedCodexSessions(targetHome, sourceHome)).toBe(0)

    expect(readFileSync(target, 'utf-8')).toBe('{"turn":1}\n{"turn":"runtime"}\n')
    expect(statSync(target).ino).not.toBe(statSync(source).ino)
    expect(existsSync(marker)).toBe(true)
  })

  it('ignores a marker that names a previously configured source', async () => {
    const oldSource = writeFile(join(root, 'old-system', 'sessions', ROLLOUT), '{"turn":1}\n')
    writeFile(join(sourceHome, 'sessions', ROLLOUT), '{"other":true}\n')
    const target = join(targetHome, 'sessions', ROLLOUT)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(oldSource, target)
    const marker = writeCopyMarker(oldSource, target)

    expect(await migrateLegacyCopiedCodexSessions(targetHome, sourceHome)).toBe(0)

    expect(readFileSync(target, 'utf-8')).toBe('{"turn":1}\n')
    expect(existsSync(marker)).toBe(true)
  })

  it('keeps a complete copy when its source was truncated or reused', async () => {
    const source = writeFile(join(sourceHome, 'sessions', ROLLOUT), '{"turn":1}\n{"turn":2}\n')
    const target = join(targetHome, 'sessions', ROLLOUT)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    const marker = writeCopyMarker(source, target)
    writeFileSync(source, '{"reused":true,"padding":"xxxxxxxx"}\n')

    expect(await migrateLegacyCopiedCodexSessions(targetHome, sourceHome)).toBe(0)

    expect(readFileSync(target, 'utf-8')).toBe('{"turn":1}\n{"turn":2}\n')
    expect(statSync(target).ino).not.toBe(statSync(source).ino)
    expect(existsSync(marker)).toBe(true)
  })
})
