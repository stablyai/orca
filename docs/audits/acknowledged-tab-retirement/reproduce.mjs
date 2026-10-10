import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyPatch, parsePatch, reversePatch } from 'diff'
import { build } from 'esbuild'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1.')
}

const root = fileURLToPath(new URL('../../../', import.meta.url))
const patch = await readFile(new URL('./fix.patch', import.meta.url), 'utf8')
const beforeSources = {}
const sourceHashes = {}
for (const parsed of parsePatch(patch)) {
  const path = parsed.newFileName.replace(/^b\//, '')
  const absolute = resolve(root, path)
  const current = await readFile(absolute, 'utf8')
  const before = applyPatch(current, reversePatch(parsed))
  if (before === false) {
    throw new Error(`Source changed; review the proof patch: ${path}`)
  }
  beforeSources[absolute.replaceAll('\\', '/')] = before
  sourceHashes[path] = {
    before: createHash('sha256').update(before).digest('hex'),
    after: createHash('sha256').update(current).digest('hex')
  }
}

for (const path of [
  'src/main/runtime/acknowledged-terminal-tab-retirement.test.ts',
  'src/main/runtime/acknowledged-terminal-tab-retirement-fixture.ts',
  'docs/audits/acknowledged-tab-retirement/fixture.test.ts'
]) {
  sourceHashes[path] = {
    current: createHash('sha256')
      .update(await readFile(resolve(root, path)))
      .digest('hex')
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'orca-acknowledged-tab-retirement-'))
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
  const includes = [
    'src/main/runtime/acknowledged-terminal-tab-retirement.test.ts',
    'docs/audits/acknowledged-tab-retirement/fixture.test.ts'
  ]
  const configImport = JSON.stringify(pathToFileURL(resolve(root, 'config/vitest.config.ts')).href)
  await writeFile(
    baselineConfig,
    `import base from ${configImport};
const beforeSources = ${JSON.stringify(beforeSources)};
export default {...base, test: {...base.test, include: ${JSON.stringify(includes)}}, plugins: [{
  name: 'acknowledged-tab-retirement-before-fix', enforce: 'pre',
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
      timedOut: result.timedOut,
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
    before.exitCode === 1 &&
    after.exitCode === 0 &&
    !before.timedOut &&
    !after.timedOut &&
    before.failed === 28 &&
    before.passed === 3 &&
    after.passed === 31 &&
    after.failed === 0
  console.log(
    JSON.stringify(
      {
        comparison:
          'Actual renderer close, durable Store, runtime close/graph/physical-exit methods; before reverses only fix.patch in a temporary Vite transform',
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
