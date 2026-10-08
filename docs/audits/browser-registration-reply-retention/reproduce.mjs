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
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
for (const parsed of parsePatch(patch)) {
  const path = parsed.newFileName.replace(/^b\//, '')
  const absolute = resolve(root, path)
  const current = await readFile(absolute, 'utf8')
  const before = applyPatch(current, reversePatch(parsed))
  if (before === false) {
    throw new Error(`Source changed; review the proof patch: ${path}`)
  }
  beforeSources[absolute.replaceAll('\\', '/')] = before
  sourceHashes[path] = { before: sha256(before), after: sha256(current) }
}

const testPath =
  'src/renderer/src/components/browser-pane/host-guest/browser-page-registration-ownership.test.ts'
const test = await readFile(resolve(root, testPath), 'utf8')
const countAssertion = '    expect(webviewRegistry.size).toBe(0)\n'
if (test.split(countAssertion).length !== 2) {
  throw new Error('Expected exactly one closed-guest count assertion; review the observer.')
}
const observedTest = `import { writeFileSync } from 'node:fs'\n${test.replace(
  countAssertion,
  `    writeFileSync(process.env.ORCA_BROWSER_REGISTRATION_COUNTS_PATH, JSON.stringify({ liveWebviews: webviewRegistry.size, registeredGuestIds: registeredWebContentsIds.size, lateAnnotationSyncs: sessions.reduce((count, page) => count + page.sync.mock.calls.length, 0), unregisterCalls: unregister.mock.calls.length }))\n${countAssertion}`
)}`
sourceHashes[testPath] = { current: sha256(test), observed: sha256(observedTest) }
const scratch = await mkdtemp(join(tmpdir(), 'orca-browser-registration-reply-'))
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
  const configImport = JSON.stringify(pathToFileURL(resolve(root, 'config/vitest.config.ts')).href)

  async function run(label, productionSources) {
    const config = join(scratch, `${label}.config.mjs`)
    const report = join(scratch, `${label}.json`)
    const countsPath = join(scratch, `${label}.counts.json`)
    const sources = {
      ...productionSources,
      [resolve(root, testPath).replaceAll('\\', '/')]: observedTest
    }
    await writeFile(
      config,
      `import base from ${configImport};
const sources = ${JSON.stringify(sources)};
export default {...base, test: {...base.test, include: [${JSON.stringify(testPath)}], maxWorkers: 1}, plugins: [{
  name: 'browser-registration-reply-audit', enforce: 'pre',
  transform(_code, id) {
    const source = sources[id.replaceAll('\\\\', '/').split('?')[0]];
    return source === undefined ? null : {code: source, map: null};
  }
}]};\n`
    )
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
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=512',
        ORCA_BROWSER_REGISTRATION_COUNTS_PATH: countsPath
      },
      timeoutMs: 60_000,
      maxOutputBytes: 2 * 1024 * 1024
    })
    let parsed
    try {
      parsed = JSON.parse(await readFile(report, 'utf8'))
    } catch (error) {
      throw new Error(`${label} failed: ${result.stderr || result.stdout}`, { cause: error })
    }
    return {
      exitCode: result.code,
      passed: parsed.numPassedTests,
      failed: parsed.numFailedTests,
      after1000ClosedGuests: JSON.parse(await readFile(countsPath, 'utf8')),
      failedCases: parsed.testResults.flatMap((suite) =>
        suite.assertionResults
          .filter((assertion) => assertion.status === 'failed')
          .map((assertion) => assertion.fullName)
      )
    }
  }

  const before = await run('before', beforeSources)
  const after = await run('after', {})
  const passed =
    before.passed === 6 &&
    before.failed === 10 &&
    after.passed === 16 &&
    after.failed === 0 &&
    before.after1000ClosedGuests.liveWebviews === 0 &&
    before.after1000ClosedGuests.registeredGuestIds === 1000 &&
    after.after1000ClosedGuests.registeredGuestIds === 0 &&
    after.after1000ClosedGuests.unregisterCalls === 1000
  console.log(
    JSON.stringify(
      {
        comparison:
          'Actual renderer guest session, recovery controller and persistent guest registry with deferred IPC replies; baseline reverses only fix.patch in a temporary source transform.',
        provenance: { node: process.version, platform: process.platform, arch: process.arch },
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
