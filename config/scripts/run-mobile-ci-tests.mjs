import { runProcess } from '@orca/process-host'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const reporters = process.argv.slice(2)
if (reporters.some((argument) => !argument.startsWith('--reporter='))) {
  throw new Error('Only additional Vitest reporters are accepted')
}
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orca-mobile-tests-')))
const abort = new AbortController()
const closed = new Set()
let signalExitCode
const onInterrupt = () => {
  signalExitCode ??= 130
  abort.abort()
}
const onTerminate = () => {
  signalExitCode ??= 143
  abort.abort()
}
process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onTerminate)

// The phone/host contract tests are typechecked by their own program; prove Bun actually ran and
// passed them, with assertions, and Node did not. Their names come from that program's roots.
function checkContractTestMembership() {
  const config = JSON.parse(readFileSync(join(root, 'mobile/tsconfig.test.node.json'), 'utf8'))
  const expected = config.files.filter((file) => /\.test\.tsx?$/.test(file))
  const read = (role) => {
    const file = join(scratch, role, 'results.json')
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).testResults ?? []) : []
  }
  const name = (entry) => relative(join(root, 'mobile'), entry.name).replaceAll('\\', '/')
  const bun = new Map(read('bun').map((entry) => [name(entry), entry]))
  const node = new Set(read('node').map(name))
  const problems = []
  for (const file of expected) {
    const assertions = bun.get(file)?.assertionResults ?? []
    if (
      bun.get(file)?.status !== 'passed' ||
      assertions.length === 0 ||
      assertions.some((assertion) => assertion.status !== 'passed')
    ) {
      problems.push(`${file} did not run and pass every assertion under Bun`)
    }
    if (node.has(file)) {
      problems.push(`${file} ran under Node`)
    }
  }
  return problems
}

async function runRole(role, program, runtimeArgs) {
  const owned = join(scratch, role)
  let launched = false
  try {
    mkdirSync(owned)
    launched = true
    return await runProcess({
      program,
      args: [
        ...runtimeArgs,
        cli,
        'run',
        '--config',
        join(root, 'config/mobile-ci.vitest.config.mjs'),
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${join(owned, 'results.json')}`,
        ...reporters
      ],
      cwd: join(root, 'mobile'),
      env: {
        ...process.env,
        TMPDIR: owned,
        TMP: owned,
        TEMP: owned,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_MOBILE_CI_CACHE_DIR: join(owned, 'cache')
      },
      stdio: 'inherit',
      timeoutMs: null,
      signal: abort.signal,
      terminationBarrier: true,
      onChildTerminated: () => closed.add(role)
    })
  } catch (error) {
    if (!launched) {
      closed.add(role)
    }
    abort.abort()
    throw error
  }
}

try {
  const results = await Promise.allSettled([
    runRole('node', process.execPath, []),
    runRole('bun', 'bun', ['--bun'])
  ])
  let exitCode = 0
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(result.reason)
      exitCode ||= 1
    } else if (result.value.code !== 0) {
      exitCode ||= result.value.code ?? 1
    }
  }
  for (const problem of checkContractTestMembership()) {
    console.error(`::error::${problem}`)
    exitCode ||= 1
  }
  process.exitCode = signalExitCode ?? exitCode
} finally {
  process.removeListener('SIGINT', onInterrupt)
  process.removeListener('SIGTERM', onTerminate)
  if (closed.size === 2) {
    rmSync(scratch, { recursive: true, force: true })
  } else {
    console.error(`Mobile test process closure is unverifiable; retained ${scratch}`)
    process.exitCode = signalExitCode ?? 1
  }
}
