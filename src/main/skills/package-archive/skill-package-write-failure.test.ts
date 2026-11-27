import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'

it('rejects an archive sink failure without stranding the source reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-write-failure-'))
  try {
    const source = join(root, 'source.txt')
    const destination = join(root, 'existing.tar.gz')
    await writeFile(source, 'x'.repeat(1024 * 1024))
    await writeFile(destination, 'original')
    const script = `
      const { writeSkillTarGzip } = require('./skill-package-tar.ts')
      writeSkillTarGzip(${JSON.stringify(destination)}, [{
        path: 'source.txt', size: 1048576, executable: false,
        sourcePath: ${JSON.stringify(source)}
      }]).then(() => process.exitCode = 1, error => console.log(error.code))
    `
    const result = await runProcess({
      program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
      args: ['--require', require.resolve('tsx/cjs'), '-e', script],
      cwd: __dirname,
      timeoutMs: 3000
    })
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false })
    expect(result.stdout.trim()).toBe('EEXIST')
    expect(await readFile(destination, 'utf8')).toBe('original')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
