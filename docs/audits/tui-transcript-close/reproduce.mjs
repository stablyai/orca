import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1.')
}

const root = fileURLToPath(new URL('../../../', import.meta.url))
const productionPath =
  'src/main/native-chat/agent-session-wire/structured-agent-session-handoff-owner-close.ts'
const testPath = 'src/main/native-chat/agent-session-wire/structured-tui-transcript-close.test.ts'
const absolute = resolve(root, productionPath)
const current = await readFile(absolute, 'utf8')
const cleanup = '  input.deps.stopTuiHistoryCatchup?.(input.sessionId)\n'
if (current.split(cleanup).length !== 2) {
  throw new Error('Expected exactly one successful-close cleanup; review the proof transform.')
}
const baseline = current.replace(cleanup, '')
const beforeSources = { [absolute.replaceAll('\\', '/')]: baseline }
const sourceHashes = {
  [productionPath]: {
    before: createHash('sha256').update(baseline).digest('hex'),
    after: createHash('sha256').update(current).digest('hex')
  },
  [testPath]: {
    current: createHash('sha256')
      .update(await readFile(resolve(root, testPath)))
      .digest('hex')
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'orca-tui-transcript-close-'))
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
  const baselineConfig = join(scratch, 'before.config.mjs')
  const fixedConfig = join(scratch, 'after.config.mjs')
  const includes = [testPath]
  const configImport = JSON.stringify(pathToFileURL(resolve(root, 'config/vitest.config.ts')).href)
  await writeFile(
    baselineConfig,
    `import base from ${configImport};
const beforeSources = ${JSON.stringify(beforeSources)};
export default {...base, test: {...base.test, include: ${JSON.stringify(includes)}}, plugins: [{
  name: 'tui-transcript-close-before-fix', enforce: 'pre',
  transform(_code, id) {
    const before = beforeSources[id.replaceAll('\\\\', '/').split('?')[0]];
    return before === undefined ? null : {code: before, map: null};
  }
}]};\n`
  )

  await writeFile(
    fixedConfig,
    `import base from ${configImport};\nexport default {...base, test: {...base.test, include: ${JSON.stringify(includes)}}};\n`
  )

  async function run(label, config) {
    const report = join(scratch, `${label}.json`)
    const result = await runProcess({
      program: process.execPath,
      args: [
        resolve(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        config,
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
      passed: parsed.numPassedTests,
      failed: parsed.numFailedTests,
      failedCases: parsed.testResults.flatMap((suite) =>
        suite.assertionResults
          .filter((test) => test.status === 'failed')
          .map((test) => test.fullName)
      )
    }
  }

  const before = await run('before', baselineConfig)
  const after = await run('after', fixedConfig)
  const passed =
    before.failed === 4 &&
    before.passed === 0 &&
    before.passed + before.failed === 4 &&
    after.passed === 4 &&
    after.failed === 0
  console.log(
    JSON.stringify(
      {
        comparison:
          'Actual structured host/store/journal/transcript watcher; baseline removes only the successful-close stop callback in a temporary Vite transform',
        sourceHashes,
        before,
        after,
        passed
      },
      null,
      2
    )
  )
  if (!passed) {
    process.exitCode = 1
  }
} finally {
  if (runnerModuleId) {
    delete require.cache[runnerModuleId]
  }
  await rm(scratch, { recursive: true, force: true })
}
