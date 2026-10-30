import { runInNewContext } from 'node:vm'
import { posix, win32 } from 'node:path'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { ADOPTED_DIRECTORY_PROBE_SOURCE } from './adopted-directory-probe'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'

async function helper(
  workspaceCwd: string,
  sourceCwd: string,
  paths: Record<string, string>,
  windows = false,
  splitOffsets: readonly number[] = []
) {
  const reads: string[] = []
  let output = ''
  const process = {
    stdin: Readable.from(
      (async function* () {
        const bytes = Buffer.from(JSON.stringify({ version: 1, workspaceCwd, sourceCwd }))
        let start = 0
        for (const end of [...splitOffsets, bytes.length]) {
          yield bytes.subarray(start, end)
          await setImmediate()
          start = end
        }
      })(),
      { objectMode: false }
    ),
    stdout: {
      write: (text: string) => {
        output += text
      }
    },
    exitCode: 0
  }
  await runInNewContext(ADOPTED_DIRECTORY_PROBE_SOURCE, {
    process,
    require: (name: string) =>
      name === 'node:path'
        ? windows
          ? win32
          : posix
        : {
            realpath: vi.fn(async (path: string) => {
              reads.push(path)
              if (!(path in paths)) {
                throw new Error('unavailable')
              }
              return paths[path]
            })
          }
  })
  return { reads, output, code: process.exitCode }
}

it('visits only selected native prefixes, stopping at a match or exhaustion', async () => {
  const result = await helper('/link/pkg', '/physical/pkg', {
    '/link/pkg': '/elsewhere',
    '/link': '/physical',
    '/': '/'
  })
  expect(result).toEqual({
    code: 0,
    output: '{"version":1,"matched":true}',
    reads: ['/link/pkg', '/link']
  })
  const noMatch = await helper('/link/pkg', '/foreign', {
    '/link/pkg': '/elsewhere',
    '/link': '/physical',
    '/': '/'
  })
  expect(noMatch.reads).toEqual(['/link/pkg', '/link', '/'])
  expect(noMatch.output).toBe('{"version":1,"matched":false}')
  const unavailable = await helper('/missing/pkg', '/foreign', { '/': '/' })
  expect(unavailable.code).toBe(1)
  expect(unavailable.output).toBe('')
  const posixBackslash = await helper('/link/pkg', '/physical\\/pkg', {
    '/link/pkg': '/elsewhere',
    '/link': '/physical\\'
  })
  expect(posixBackslash.output).toBe('{"version":1,"matched":true}')
  expect(posixBackslash.reads).toEqual(['/link/pkg', '/link'])
})

it('keeps native drive/UNC, NFC and POSIX comparison semantics, without source dot collapsing', async () => {
  for (const [workspace, resolved, source, windows] of [
    ['C:\\link\\pkg', 'D:\\Physical\\pkg', 'd:/physical/pkg/', true],
    ['\\\\host\\share\\link', '\\\\host\\share\\Physical', '//HOST/share/physical', true],
    ['C:\\link', '\\\\wsl.localhost\\Ubuntu\\Repo', '//wsl$/ubuntu/Repo', true],
    ['C:\\link', '\\\\wsl.localhost\\Ubuntu\\Repo', '//wsl$/ubuntu/repo', true],
    ['/link', '/café', '/cafe\u0301', false],
    ['/link', '/Physical', '/physical', false],
    ['/link', '/physical', '/other/../physical', false]
  ] as const) {
    const path = windows ? win32 : posix
    const paths: Record<string, string> = { [workspace]: resolved }
    for (let parent = path.dirname(workspace); !(parent in paths); parent = path.dirname(parent)) {
      paths[parent] = parent
      if (path.dirname(parent) === parent) {
        break
      }
    }
    const result = await helper(workspace, source, paths, windows)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.output).matched).toBe(
      normalizeRuntimePathForComparison(resolved) === normalizeRuntimePathForComparison(source)
    )
  }
  const wsl = await helper('\\\\wsl.localhost\\Ubuntu\\repo', '/repo', {}, true)
  expect(wsl.code).toBe(1)
  expect(wsl.reads).toEqual([])
})

it.each(['é', '界', '😀'])(
  'preserves %s in W and C across byte delivery schedules',
  async (character) => {
    const parent = `/selected-${character}`
    const workspaceCwd = `${parent}/pkg`
    const physical = `/physical-${character}`
    const paths = {
      [workspaceCwd]: '/elsewhere',
      [parent]: physical.normalize('NFD'),
      '/': '/'
    }
    for (const matched of [true, false]) {
      const sourceCwd = matched ? `${physical}/pkg` : `/foreign-${character}/pkg`
      const bytes = Buffer.from(JSON.stringify({ version: 1, workspaceCwd, sourceCwd }))
      const expected = {
        code: 0,
        output: JSON.stringify({ version: 1, matched }),
        reads: matched ? [workspaceCwd, parent] : [workspaceCwd, parent, '/']
      }
      expect(await helper(workspaceCwd, sourceCwd, paths)).toEqual(expected)
      for (let offset = 1; offset < Buffer.byteLength(character); offset++) {
        const w = bytes.indexOf(character) + offset
        const c = bytes.lastIndexOf(character) + offset
        for (const splits of [[w], [c], [w, c]]) {
          expect(await helper(workspaceCwd, sourceCwd, paths, false, splits)).toEqual(expected)
        }
      }
    }
  }
)
