import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')
const itWindows = process.platform === 'win32' ? it : it.skip

describe('Windows ReFS block-clone helper', () => {
  it('uses the ReFS extent-duplication control code with bounded chunks', () => {
    const source = readFileSync(
      join(projectRoot, 'native', 'windows-block-clone', 'OrcaBlockClone.cs'),
      'utf8'
    )

    expect(source).toContain('FsctlDuplicateExtentsToFile = 0x00098344')
    expect(source).toContain('MaxCloneChunk = 1024L * 1024L * 1024L')
    expect(source).toContain('length - (length % clusterSize)')
    expect(source).toContain('sourceStream.CopyTo(targetStream, FileBufferSize)')
    expect(source).toContain('DeviceIoControl(')
    expect(source).toContain('Directory.Move(temporary, target)')
    expect(source).toContain('File.Move(temporary, target)')
  })

  itWindows(
    'compiles and rejects non-ReFS or cross-volume probes without copying',
    { timeout: 15_000 },
    () => {
      const outputRoot = mkdtempSync(join(tmpdir(), 'orca block clone '))
      try {
        const helperPath = join(outputRoot, 'orca-block-clone.exe')
        const build = spawnSync(
          process.execPath,
          ['config/scripts/build-windows-block-clone.mjs', '--output', helperPath],
          { cwd: projectRoot, encoding: 'utf8' }
        )
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)
        expect(existsSync(helperPath)).toBe(true)

        const probe = spawnSync(helperPath, ['probe', projectRoot, outputRoot], {
          encoding: 'utf8'
        })
        expect([0, 2]).toContain(probe.status)
      } finally {
        rmSync(outputRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
  )
})
