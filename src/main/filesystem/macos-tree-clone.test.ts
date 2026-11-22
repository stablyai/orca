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
})
