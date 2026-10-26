import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifySynchronousRipgrepSpawnFailure,
  RipgrepLaunchFailureError,
  RipgrepUnavailableError
} from '../../shared/ripgrep-process-availability'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fileAsSearchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rg-sync-'))
  dirs.push(dir)
  const path = join(dir, 'not-a-directory')
  writeFileSync(path, '')
  return path
}

describe('synchronous ripgrep spawn failures', () => {
  // Real spawn proves Node throws unsupported async errnos inline; handcrafted errors cannot establish that.
  it.skipIf(process.platform === 'win32')(
    'throws inline rather than emitting error when the root is a file',
    () => {
      const root = fileAsSearchRoot()

      expect(() => spawn(process.execPath, ['-e', ''], { cwd: root, stdio: 'ignore' })).toThrow(
        expect.objectContaining({ code: 'ENOTDIR' })
      )
    }
  )

  it.skipIf(process.platform === 'win32')(
    'names the unreachable root instead of surfacing a raw spawn errno',
    async () => {
      const root = fileAsSearchRoot()
      let thrown: unknown
      try {
        spawn(process.execPath, ['-e', ''], { cwd: root, stdio: 'ignore' })
      } catch (error) {
        thrown = error
      }

      const verdict = await classifySynchronousRipgrepSpawnFailure(thrown, root)

      expect(verdict.message).toBe(`Search root is not reachable: ${root}`)
    }
  )

  it('reports fd/process pressure as retryable, not as a broken install', async () => {
    const verdict = await classifySynchronousRipgrepSpawnFailure(
      Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }),
      process.cwd()
    )

    expect(verdict).toBeInstanceOf(RipgrepLaunchFailureError)
    expect(verdict.message).toContain('EMFILE')
  })

  // Preserve an existing binary verdict rather than replace it with lower-context cwd diagnosis.
  it('passes an already-classified error straight through', async () => {
    const original = new RipgrepUnavailableError()

    expect(await classifySynchronousRipgrepSpawnFailure(original, '/definitely/not/here')).toBe(
      original
    )
  })
})
