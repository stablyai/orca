import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const itCrossHost = process.platform === 'win32' ? it.skip : it
const projectRoot = resolve(import.meta.dirname, '../..')
const buildScriptPath = join(projectRoot, 'config', 'scripts', 'build-windows-programs-path.mjs')

function itWindows(name, test) {
  const runner = process.platform === 'win32' ? it : it.skip
  runner(name, { timeout: 15_000 }, test)
}

describe('Windows Programs known-folder bridge', () => {
  it('emits UTF-8 for redirected folder names', () => {
    const source = readFileSync(
      join(projectRoot, 'native', 'windows-programs-path', 'WindowsProgramsPath.cs'),
      'utf8'
    )

    expect(source).toContain('Console.OutputEncoding = new UTF8Encoding(false);')
  })

  itCrossHost('fails closed when the bridge cannot be compiled on this host', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'orca cross-host programs path '))
    try {
      const result = spawnSync(
        process.execPath,
        [buildScriptPath, '--output', join(outputRoot, 'bridge.exe')],
        { cwd: projectRoot, encoding: 'utf8' }
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Windows Programs known-folder bridge')
      expect(result.stderr).toContain('Windows host')
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })

  itWindows('returns FOLDERID_Programs from the native Shell API', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'orca programs path '))
    try {
      const bridgePath = join(outputRoot, 'orca-programs-path.exe')
      const build = spawnSync(process.execPath, [buildScriptPath, '--output', bridgePath], {
        cwd: projectRoot,
        encoding: 'utf8'
      })
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)

      const query = spawnSync(bridgePath, [], { encoding: 'utf8' })
      expect(query.status, query.stderr).toBe(0)
      expect(win32.isAbsolute(query.stdout.trim())).toBe(true)
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })
})
