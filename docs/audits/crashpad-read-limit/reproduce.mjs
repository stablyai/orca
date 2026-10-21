import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1.')
}

const root = fileURLToPath(new URL('../../../', import.meta.url))
const expectedHashes = JSON.parse(
  await readFile(new URL('./source-hashes.json', import.meta.url), 'utf8')
)
const sourceHashes = {}
for (const [path, expected] of Object.entries(expectedHashes)) {
  const actual = createHash('sha256')
    .update(await readFile(resolve(root, path)))
    .digest('hex')
  if (actual !== expected) {
    throw new Error(`Source hash changed; review this evidence: ${path}`)
  }
  sourceHashes[path] = actual
}

const scratch = await mkdtemp(join(tmpdir(), 'orca-crashpad-read-limit-'))
const require = createRequire(import.meta.url)
let runnerModuleId
try {
  const runnerPath = join(scratch, 'run-process.cjs')
  await build({
    absWorkingDir: root,
    entryPoints: [resolve(root, 'src/shared/child-process/run-process.ts')],
    outfile: runnerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  runnerModuleId = require.resolve(runnerPath)
  const { runProcess } = require(runnerModuleId)
  const includes = [
    'src/main/crash-reporting/crashpad-capture-read-limit.test.ts',
    'src/main/crash-reporting/minidump-file-source.test.ts'
  ]
  const deadlinePath = resolve(root, 'src/main/crash-reporting/minidump-file-source.ts')
  const current = await readFile(deadlinePath, 'utf8')
  const deadlineCondition =
    'size > 0 && options.deadlineMs !== undefined && now() >= options.deadlineMs'
  if (current.split(deadlineCondition).length !== 2) {
    throw new Error('Deadline mutation no longer identifies exactly one branch.')
  }
  const withoutDeadline = current.replace(deadlineCondition, 'false')
  const deadlineConfig = join(scratch, 'without-deadline.config.mjs')
  const fixedConfig = join(scratch, 'fixed.config.mjs')
  const config = {
    test: {
      environment: 'node',
      include: includes,
      testTimeout: 30_000,
      execArgv: ['--no-experimental-webstorage']
    }
  }
  await writeFile(
    deadlineConfig,
    `export default {...${JSON.stringify(config)}, plugins: [{
      name: 'disable-extent-deadline', enforce: 'pre',
      transform(_code, id) {
        return id.split('?')[0].replaceAll('\\\\', '/') === ${JSON.stringify(deadlinePath.replaceAll('\\', '/'))}
          ? {code: ${JSON.stringify(withoutDeadline)}, map: null} : null;
      }
    }]};\n`
  )
  await writeFile(fixedConfig, `export default ${JSON.stringify(config)};\n`)

  async function run(label, configPath) {
    const report = join(scratch, `${label}.json`)
    const result = await runProcess({
      program: process.execPath,
      args: [
        resolve(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        configPath,
        '--reporter=json',
        `--outputFile=${report}`
      ],
      cwd: root,
      env: process.env,
      timeoutMs: 90_000,
      maxOutputBytes: 4 * 1024 * 1024
    })
    let parsed
    try {
      parsed = JSON.parse(await readFile(report, 'utf8'))
    } catch (error) {
      throw new Error(`${label} runner failed: ${result.stderr || result.stdout}`, { cause: error })
    }
    return {
      exitCode: result.code,
      timedOut: result.timedOut,
      passed: parsed.numPassedTests,
      failed: parsed.numFailedTests,
      skipped: parsed.numPendingTests,
      failedCases: parsed.testResults.flatMap((suite) =>
        suite.assertionResults
          .filter((test) => test.status === 'failed')
          .map((test) => test.fullName)
      )
    }
  }

  const withoutDeadlineResult = await run('without-deadline', deadlineConfig)
  const fixed = await run('fixed', fixedConfig)
  const expectedFailures = [1, 2].map(
    (pages) => `stops observing a growing size-zero dump after the deadline at page ${pages}`
  )
  const skippedSymlink = fsConstants.O_NOFOLLOW ? 0 : 1
  const passed =
    withoutDeadlineResult.exitCode === 1 &&
    !withoutDeadlineResult.timedOut &&
    withoutDeadlineResult.failed === 2 &&
    withoutDeadlineResult.passed === 24 - skippedSymlink &&
    withoutDeadlineResult.skipped === skippedSymlink &&
    JSON.stringify(withoutDeadlineResult.failedCases) === JSON.stringify(expectedFailures) &&
    fixed.exitCode === 0 &&
    !fixed.timedOut &&
    fixed.passed === 26 - skippedSymlink &&
    fixed.failed === 0 &&
    fixed.skipped === skippedSymlink
  const result = {
    comparison:
      'Current capture and file-source regressions; negative control removes only the extent deadline in memory.',
    sourceHashes,
    withoutDeadline: withoutDeadlineResult,
    fixed,
    passed
  }
  await writeFile(
    new URL('./results.json', import.meta.url),
    `${JSON.stringify(result, null, 2)}\n`
  )
  console.log(JSON.stringify(result, null, 2))
  if (!passed) {
    process.exitCode = 1
  }
} finally {
  if (runnerModuleId) {
    delete require.cache[runnerModuleId]
  }
  await rm(scratch, { recursive: true, force: true })
}
