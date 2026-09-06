import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../../shared/child-process/run-process'
import { WorktreeLinkedPathTargetExistsError } from './worktree-apfs-clone'
import {
  canCloneWithRefs,
  cloneWorktreePathWithRefs,
  RefsCloneUnavailableError,
  type RefsCloneDeps
} from './worktree-refs-clone'

const successResult: ProcessResult = {
  code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false
}

describe('ReFS worktree block clone', () => {
  let root: string
  let source: string
  let targetDirectory: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-refs-clone-'))
    source = join(root, 'source.bin')
    targetDirectory = join(root, 'target')
    await writeFile(source, 'source')
    await mkdir(targetDirectory)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function depsWithResult(result = successResult): RefsCloneDeps {
    return {
      resolveHelperPath: () => 'C:\\Orca\\orca-block-clone.exe',
      runProcess: vi.fn(async () => result)
    }
  }

  it('probes the native helper once per source/target volume pair', async () => {
    const secondSource = join(root, 'second.bin')
    await writeFile(secondSource, 'second')
    const deps = depsWithResult()
    const cache = new Map<string, Promise<boolean>>()

    await expect(canCloneWithRefs(source, targetDirectory, deps, cache)).resolves.toBe(true)
    await expect(canCloneWithRefs(secondSource, targetDirectory, deps, cache)).resolves.toBe(true)

    expect(deps.runProcess).toHaveBeenCalledTimes(1)
    expect(deps.runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'C:\\Orca\\orca-block-clone.exe',
        args: ['probe', source, targetDirectory]
      })
    )
  })

  it('answers false when the helper or a same-volume ReFS path is unavailable', async () => {
    const missingHelper: RefsCloneDeps = {
      resolveHelperPath: () => null,
      runProcess: vi.fn()
    }
    await expect(canCloneWithRefs(source, targetDirectory, missingHelper)).resolves.toBe(false)

    const unsupported = depsWithResult({
      ...successResult,
      code: 2,
      stderr: 'Source and target must be on the same ReFS volume.'
    })
    await expect(canCloneWithRefs(source, targetDirectory, unsupported)).resolves.toBe(false)
  })

  it('runs the helper clone command after creating the target parent', async () => {
    const deps = depsWithResult()
    const target = join(targetDirectory, 'nested', 'payload.bin')

    await cloneWorktreePathWithRefs(source, target, false, deps)

    expect(deps.runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['clone', source, target]
      })
    )
  })

  it('maps helper fallback and target-race exits to typed errors', async () => {
    const target = join(targetDirectory, 'payload.bin')
    const unavailable = depsWithResult({
      ...successResult,
      code: 2,
      stderr: 'not same-volume ReFS'
    })
    await expect(cloneWorktreePathWithRefs(source, target, false, unavailable)).rejects.toThrow(
      RefsCloneUnavailableError
    )

    const conflict = depsWithResult({
      ...successResult,
      code: 3,
      stderr: 'target exists'
    })
    await expect(cloneWorktreePathWithRefs(source, target, false, conflict)).rejects.toThrow(
      WorktreeLinkedPathTargetExistsError
    )
  })
})
