import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifySynchronousRipgrepSpawnFailure } from '../../shared/ripgrep/ripgrep-process-availability'

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
})
