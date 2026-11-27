import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('rejects a writerless FIFO upload source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-sftp-fifo-'))
  try {
    const source = join(root, 'source')
    expect((await runProcess({ program: 'mkfifo', args: [source], timeoutMs: 2000 })).code).toBe(0)
    const bundle = buildSync({
      entryPoints: [join(import.meta.dirname, 'sftp-file-upload.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false
    }).outputFiles[0]!.text
    const script = join(root, 'upload.cjs')
    await writeFile(
      script,
      `${bundle}\n` +
        `const session = new (require('node:events').EventEmitter)();\n` +
        `module.exports.uploadFile(session, ${JSON.stringify(source)}, '/remote/file')` +
        `.then(() => process.exitCode = 1, error => console.log(error.message));\n`
    )
    const result = await runProcess({
      program: process.execPath,
      args: [script],
      timeoutMs: 2000
    })
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(`Unsupported upload source: ${source}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
