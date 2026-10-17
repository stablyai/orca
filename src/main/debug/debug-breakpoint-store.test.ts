import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DebugBreakpointStore,
  normalizeDebugPath,
  withheldFrom,
  type DebugBreakpoint
} from './debug-breakpoint-store'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function scratch(): { dir: string; root: string; file: string; storePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-bp-store-'))
  dirs.push(dir)
  const root = join(dir, 'repo')
  mkdirSync(root)
  const file = join(root, 'main.py')
  writeFileSync(file, 'print(1)\n')
  return { dir, root, file, storePath: join(dir, 'state', 'breakpoints.json') }
}

describe('DebugBreakpointStore', () => {
  it('adds, updates and removes entries per root and file', () => {
    const { root, file, storePath } = scratch()
    const store = new DebugBreakpointStore({ filePath: storePath })
    const a = store.add(root, file, { line: 3 })
    const b = store.add(root, file, { line: 7, condition: 'x > 1' })
    expect(a).toMatchObject({ line: 3, enabled: true })
    expect(store.update(root, file, b.id, { enabled: false, hitCondition: '2' })).toMatchObject({
      id: b.id,
      line: 7,
      enabled: false,
      condition: 'x > 1',
      hitCondition: '2'
    })
    expect(store.update(root, file, 'missing', { line: 1 })).toBeNull()
    expect(store.remove(root, file, a.id)).toBe(true)
    expect(store.remove(root, file, a.id)).toBe(false)
    expect(store.forFile(root, file).map((e) => e.id)).toEqual([b.id])
    expect(store.files(join(root, 'elsewhere'))).toEqual([])
  })

  it('setFileLines moves listed entries and drops the rest', () => {
    const { root, file, storePath } = scratch()
    const store = new DebugBreakpointStore({ filePath: storePath })
    const a = store.add(root, file, { line: 3, logMessage: 'hi' })
    const b = store.add(root, file, { line: 5 })
    const c = store.add(root, file, { line: 9 })
    store.setFileLines(root, file, [
      { id: a.id, line: 4 },
      { id: c.id, line: 4 }
    ])
    const entries = store.forFile(root, file)
    expect(entries).toEqual([{ ...a, line: 4 }])
    expect(entries.some((e) => e.id === b.id)).toBe(false)
  })

  it('round-trips through the file, written with mode 0600', () => {
    const { root, file, storePath } = scratch()
    const first = new DebugBreakpointStore({ filePath: storePath })
    const entry = first.add(root, file, { line: 2, column: 5, logMessage: 'v={v}' })
    if (process.platform !== 'win32') {
      expect(statSync(storePath).mode & 0o777).toBe(0o600)
    }
    const second = new DebugBreakpointStore({ filePath: storePath })
    expect(second.forFile(root, file)).toEqual([entry])
    expect(second.files(root)).toEqual([normalizeDebugPath(file)])
    expect(readdirSync(join(storePath, '..')).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('moves a corrupt file aside with a warning and starts empty', () => {
    const { root, file, storePath } = scratch()
    mkdirSync(join(storePath, '..'), { recursive: true })
    writeFileSync(storePath, '{"version":1,"roots":{"x":')
    const warnings: string[] = []
    const store = new DebugBreakpointStore({ filePath: storePath, warn: (m) => warnings.push(m) })
    expect(store.files(root)).toEqual([])
    expect(warnings.join('\n')).toMatch(/corrupt/)
    const aside = readdirSync(join(storePath, '..')).filter((n) => n.includes('.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(storePath, '..', aside[0]), 'utf8')).toBe('{"version":1,"roots":{"x":')
    store.add(root, file, { line: 1 })
    expect(new DebugBreakpointStore({ filePath: storePath }).forFile(root, file)).toHaveLength(1)
  })

  it('treats a well-formed file of the wrong shape as corrupt', () => {
    const { storePath } = scratch()
    mkdirSync(join(storePath, '..'), { recursive: true })
    writeFileSync(
      storePath,
      JSON.stringify({ version: 1, roots: { '/r': { '/r/a': [{ line: 'x' }] } } })
    )
    const warnings: string[] = []
    expect(
      () => new DebugBreakpointStore({ filePath: storePath, warn: (m) => warnings.push(m) })
    ).not.toThrow()
    expect(warnings).toHaveLength(1)
  })

  it('keys on the realpath with case preserved, so a symlinked spelling agrees', () => {
    const { dir, root, file, storePath } = scratch()
    const link = join(dir, 'Linked')
    symlinkSync(root, link, 'dir')
    const store = new DebugBreakpointStore({ filePath: storePath })
    const changes: string[][] = []
    store.onChange((r, f) => changes.push([r, f]))
    const entry = store.add(link, join(link, 'main.py'), { line: 1 })
    expect(store.forFile(root, file)).toEqual([entry])
    expect(changes).toEqual([[normalizeDebugPath(root), normalizeDebugPath(file)]])
    expect(normalizeDebugPath(join(link, 'Not', 'Yet.py'))).toBe(
      join(normalizeDebugPath(root), 'Not', 'Yet.py')
    )
    if (process.platform === 'darwin') {
      expect(normalizeDebugPath('/tmp')).toBe(normalizeDebugPath('/private/tmp'))
    }
  })

  it('realpath-normalises keys read from disk, merging spellings that collapse to one file; an old file without authors loads as ui', () => {
    const { dir, root, file, storePath } = scratch()
    const link = join(dir, 'Linked')
    symlinkSync(root, link, 'dir')
    mkdirSync(join(dir, 'state'))
    const entry = (id: string, line: number) => ({ id, line, enabled: true })
    const roots = {
      [link]: { [join(link, 'main.py')]: [entry('a', 1)] },
      [root]: { [file]: [entry('b', 2)] }
    }
    writeFileSync(storePath, JSON.stringify({ version: 1, roots }))
    const store = new DebugBreakpointStore({ filePath: storePath })
    expect(store.forFile(normalizeDebugPath(root), normalizeDebugPath(file))).toEqual([
      { ...entry('a', 1), author: 'ui' },
      { ...entry('b', 2), author: 'ui' }
    ])
    expect(store.files(root)).toEqual([normalizeDebugPath(file)])
  })
})

describe('DebugBreakpointStore authors', () => {
  it('records the author, persists it, and withholds only an agent’s code fields from a person’s session', () => {
    const { root, file, storePath } = scratch()
    const store = new DebugBreakpointStore({ filePath: storePath })
    const agent = store.add(root, file, { line: 1, condition: 'x', author: 'cli' })
    const person = store.add(root, file, { line: 2, condition: 'y' })
    const plain = store.add(root, file, { line: 3, author: 'cli' })
    expect([agent.author, person.author, plain.author]).toEqual(['cli', 'ui', 'cli'])
    const reloaded = new DebugBreakpointStore({ filePath: storePath })
    expect(reloaded.forFile(root, file).map((bp) => bp.author)).toEqual(['cli', 'ui', 'cli'])
    const lines = (bps: DebugBreakpoint[]) =>
      bps.map(({ line, condition }) => ({ line, condition }))
    // Unset audience counts as a person's session.
    const toPerson = [
      { line: 1, condition: undefined },
      { line: 2, condition: 'y' }
    ]
    expect(lines(store.forSession(root, file))).toEqual([
      ...toPerson,
      { line: 3, condition: undefined }
    ])
    store.setAudience(root, 'cli')
    expect(lines(store.forSession(root, file)).map((bp) => bp.condition)).toEqual([
      'x',
      'y',
      undefined
    ])
    // forFile, what the UI lists, is never stripped.
    expect(store.forFile(root, file)[0].condition).toBe('x')
    expect(withheldFrom(agent, 'ui')).toBe(true)
    expect(withheldFrom(plain, 'ui')).toBe(false)
  })
})
