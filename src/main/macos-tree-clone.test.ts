import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessHost from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

const { runProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>()
}))
vi.mock('@orca/process-host', async (importActual) => {
  const actual = await importActual<typeof ProcessHost>()
  runProcessMock.mockImplementation((spec) => actual.runProcess(spec))
  return { runProcess: runProcessMock }
})

import { cloneMacTree } from './macos-tree-clone'

const ok: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }

describe('cloneMacTree', () => {
  let root: string
  let source: string
  let destination: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-mac-tree-clone-'))
    source = join(root, 'source')
    destination = join(root, 'copy')
    await mkdir(join(source, 'ws'), { recursive: true })
    await writeFile(join(source, 'ws', 'index.js'), 'ws')
    await symlink('../gone/index.js', join(source, 'dangling'))
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it.runIf(process.platform === 'darwin')(
    'clones a real tree in one step, replacing an existing destination instead of nesting',
    async () => {
      await mkdir(join(destination, 'stale'), { recursive: true })
      await cloneMacTree(source, destination)
      expect(runProcessMock).toHaveBeenCalledTimes(1)
      expect((await readdir(destination)).sort()).toEqual(['dangling', 'ws'])
      expect(await readFile(join(destination, 'ws', 'index.js'), 'utf8')).toBe('ws')
      expect(await readlink(join(destination, 'dangling'))).toBe('../gone/index.js')
    }
  )

  it('falls back to a plain copy over a cleared destination when the clone fails', async () => {
    const seenAtCopy: boolean[] = []
    runProcessMock.mockImplementation(async (spec) => {
      seenAtCopy.push(existsSync(destination))
      if (spec.args?.[0] === '-cR') {
        await mkdir(destination)
        await writeFile(join(destination, 'partial'), 'partial-clone')
        return { ...ok, code: 1 }
      }
      return ok
    })
    const signal = new AbortController().signal
    await cloneMacTree('/src', destination, signal)
    expect(runProcessMock.mock.calls.map(([spec]) => spec)).toMatchObject([
      { program: '/bin/cp', args: ['-cR', '/src', destination], timeoutMs: null, signal },
      { program: '/bin/cp', args: ['-R', '/src', destination], timeoutMs: null, signal }
    ])
    expect(seenAtCopy).toEqual([false, false])
  })

  it('throws when neither copy succeeds', async () => {
    runProcessMock.mockResolvedValue({ ...ok, code: 1 })
    await expect(cloneMacTree('/src/node_modules', destination)).rejects.toThrow(
      'Could not copy node_modules'
    )
    expect(runProcessMock).toHaveBeenCalledTimes(2)
  })
})
