import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import loadSources from './sources.cjs'
import { startVitest } from 'vitest/node'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1.')
}
const { root, sourceRelativePath, baseline, candidate, windowCandidate } = loadSources()
const files = [
  'src/main/native-chat/session-file-resolver.test.ts',
  'src/main/claude/claude-transcript-rewind-proof.test.ts',
  'src/main/claude/claude-structured-session-recovery.test.ts',
  'src/main/claude/claude-structured-history-window.test.ts'
]
const scratch = await mkdtemp(join(tmpdir(), 'orca-branch-streaming-regressions-'))
const reports = []
try {
  for (const [phase, source] of Object.entries({ baseline, candidate, windowCandidate })) {
    const config = join(scratch, `${phase}.config.mjs`)
    const report = join(scratch, `${phase}.json`)
    await writeFile(
      config,
      `
import base from ${JSON.stringify(pathToFileURL(join(root, 'config/vitest.config.ts')).href)}
export default {
  ...base,
  plugins: [{ name: 'branch-streaming-before-after', enforce: 'pre', transform(code, id) {
    if (${JSON.stringify(phase)} !== 'windowCandidate' && id.replaceAll('\\\\', '/').endsWith(${JSON.stringify(`/${sourceRelativePath}`)})) return ${JSON.stringify(source)}
  }}],
  test: { ...base.test, include: ${JSON.stringify(files.map((file) => join(root, file)))}, maxWorkers: 1, fileParallelism: false }
}
`
    )
    const runner = await startVitest('test', [], {
      root,
      config,
      watch: false,
      reporters: ['dot', 'json'],
      outputFile: { json: report }
    })
    assert(runner, 'Vitest did not start')
    await runner.close()
    const result = JSON.parse(await readFile(report, 'utf8'))
    assert.equal(result.success, true)
    reports.push({ phase, passed: result.numPassedTests, failed: result.numFailedTests, files })
  }
  const output = `${JSON.stringify({ reports }, null, 2)}\n`
  if (process.argv[2]) {
    await writeFile(resolve(process.argv[2]), output)
  }
  process.stdout.write(output)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
