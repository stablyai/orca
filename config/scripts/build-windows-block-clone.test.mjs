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
      join(projectRoot, 'native', 'windows-block-clone', 'OrcaBlockClone.cpp'),
      'utf8'
    )

    expect(source).toContain('FSCTL_DUPLICATE_EXTENTS_TO_FILE')
    expect(source).toContain('MaxCloneChunk = 1024LL * 1024LL * 1024LL')
    expect(source).toContain('length.QuadPart - (length.QuadPart % clusterSize)')
    expect(source).toContain('CopyTail(')
    expect(source).toContain('DeviceIoControl(')
    expect(source).toContain('MoveFileExW(')
  })

  it('bounds directory clone concurrency by the active CPU thread count', () => {
    const source = readFileSync(
      join(projectRoot, 'native', 'windows-block-clone', 'OrcaBlockClone.cpp'),
      'utf8'
    )

    expect(source).toContain('GetActiveProcessorCount(ALL_PROCESSOR_GROUPS)')
    expect(source).toContain('std::min(itemCount, ProcessorThreadCount())')
    expect(source).toContain('std::atomic<std::size_t> next')
    expect(source).toContain('workers.emplace_back(worker)')
    expect(source).toContain('RunParallel(plan.directories.size()')
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
