import { runInNewContext } from 'node:vm'
import { posix, win32 } from 'node:path'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { ADOPTED_DIRECTORY_PROBE_SOURCE } from './adopted-directory-probe'

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
