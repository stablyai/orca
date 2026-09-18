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
const productionPath = 'src/main/browser/browser-manager-guest-navigation-policy.ts'
const testPath = 'src/main/browser/browser-manager-destroyed-guest.test.ts'
const fixturePath = 'src/main/browser/browser-manager-destroyed-guest-test-fixture.ts'
const current = await readFile(resolve(root, productionPath), 'utf8')
const fix = `      const browserTabId = this.tabIdByWebContentsId.get(guest.id)
      // A destroyed primary guest also owns per-page callbacks that capture its WebContents.
      if (browserTabId && this.webContentsIdByTabId.get(browserTabId) === guest.id) {
        this.unregisterGuest(browserTabId, 'guest-destroyed')
        return
      }
`
if (current.split(fix).length !== 2) {
  throw new Error('Expected exactly one primary-guest destruction guard; review the transform.')
}
const baseline = current.replace(fix, '')
const test = await readFile(resolve(root, testPath), 'utf8')
const observe = '    const counts = manager.retainedCounts()\n'
if (test.split(observe).length !== 2) {
  throw new Error('Expected exactly one retained-count observer; review the transform.')
}
const observedTest = `import { appendFileSync } from 'node:fs'\n${test.replace(
  observe,
  `${observe}    appendFileSync(process.env.ORCA_BROWSER_GUEST_COUNTS_PATH, JSON.stringify({ test: expect.getState().currentTestName, counts }) + '\\n')\n`
)}`
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const sourceHashes = {
  [productionPath]: { before: sha256(baseline), after: sha256(current) },
  [testPath]: { current: sha256(test), observed: sha256(observedTest) },
  [fixturePath]: { current: sha256(await readFile(resolve(root, fixturePath))) }
}
for (const path of [
  'src/main/browser/browser-manager-state.ts',
  'src/main/browser/browser-manager-registration.ts',
  'src/main/browser/browser-manager-download-lifecycle.ts'
]) {
  sourceHashes[path] = { current: sha256(await readFile(resolve(root, path))) }
}
const scratch = await mkdtemp(join(tmpdir(), 'orca-browser-destroyed-guest-'))
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

  async function run(label, production) {
    const config = join(scratch, `${label}.config.mjs`)
    const report = join(scratch, `${label}.json`)
    const countsPath = join(scratch, `${label}.counts.jsonl`)
    const sources = {
      [resolve(root, productionPath).replaceAll('\\', '/')]: production,
      [resolve(root, testPath).replaceAll('\\', '/')]: observedTest
    }
    await writeFile(
      config,
      `import base from ${configImport};
const sources = ${JSON.stringify(sources)};
export default {...base, test: {...base.test, include: [${JSON.stringify(testPath)}], maxWorkers: 1}, plugins: [{
  name: 'browser-destroyed-guest-audit', enforce: 'pre',
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
        ORCA_BROWSER_GUEST_COUNTS_PATH: countsPath
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
    const counts = (await readFile(countsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    return {
      exitCode: result.code,
      passed: parsed.numPassedTests,
      failed: parsed.numFailedTests,
      counts,
      failedCases: parsed.testResults.flatMap((suite) =>
        suite.assertionResults
          .filter((assertion) => assertion.status === 'failed')
          .map((assertion) => assertion.fullName)
      )
    }
  }

  const before = await run('before', baseline)
  const after = await run('after', current)
  const passed =
    before.passed === 6 &&
    before.failed === 3 &&
    after.passed === 9 &&
    after.failed === 0 &&
    before.counts.length === 9 &&
    after.counts.length === 9 &&
    before.counts[0].counts.contextMenus === 1000 &&
    before.counts[1].counts.contextMenus === 1000 &&
    after.counts[0].counts.contextMenus === 0 &&
    after.counts[1].counts.contextMenus === 0
  console.log(
    JSON.stringify(
      {
        comparison:
          'Actual BrowserManager registration, destroyed-event handler, callback maps and unregisterAll; Electron methods use EventEmitter fixtures. Baseline removes only the exact-primary destruction cleanup in a temporary source transform.',
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
