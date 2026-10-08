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
  // Why a real spawn: the whole reason this path exists is that Node throws inline for errnos
  // outside its async set. Asserting against a hand-made error would not prove that happens.
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

  // Why: a caller that already reached a verdict has more context than a cwd probe does, and
  // re-diagnosing it would turn "the binary is broken" into "your workspace moved".
  it('passes an already-classified error straight through', async () => {
    const original = new RipgrepUnavailableError()

    expect(await classifySynchronousRipgrepSpawnFailure(original, '/definitely/not/here')).toBe(
      original
    )
  })
})
