import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./wsl', () => ({
  parseWslPath: vi.fn(() => null),
  toLinuxPath: vi.fn((value: string) => value)
}))

// Why: the real 20s timeout would make the orphan check take half a minute.
vi.mock('./format-on-save-timeout', () => ({ FORMAT_ON_SAVE_TIMEOUT_MS: 1000 }))

import { executeFormatCommand } from './format-on-save-process'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'format-on-save-process-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

// Why: real processes on purpose — the regression is an orphan outliving the
// kill, which no mock of the spawn layer can observe. Windows tree kill has its
// own coverage in src/shared/child-process.
describe.skipIf(process.platform === 'win32')('executeFormatCommand with a real shell', () => {
  it('kills a formatter the shell started when the run times out', async () => {
    const marker = join(workDir, 'orphan-wrote-this')
    const result = await executeFormatCommand({
      command: `(sleep 2 && echo late > '${marker}') & sleep 30`,
      worktreePath: workDir,
      absoluteFilePath: join(workDir, 'a.ts'),
      relativePath: 'a.ts'
    })

    expect(result).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('timed out')
    })
    // Why: wait past the orphan's own delay so a surviving child would have written by now.
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(existsSync(marker)).toBe(false)
  })

  it('reports a chatty successful formatter as completed', async () => {
    await expect(
      executeFormatCommand({
        command: 'yes x | head -c 3000000; echo done >&2',
        worktreePath: workDir,
        absoluteFilePath: join(workDir, 'a.ts'),
        relativePath: 'a.ts'
      })
    ).resolves.toEqual({ status: 'completed' })
  })

  it('reports stderr for a failing formatter', async () => {
    await expect(
      executeFormatCommand({
        command: 'echo "SyntaxError: bad" >&2; exit 3',
        worktreePath: workDir,
        absoluteFilePath: join(workDir, 'a.ts'),
        relativePath: 'a.ts'
      })
    ).resolves.toEqual({ status: 'failed', message: 'SyntaxError: bad' })
  })
})
