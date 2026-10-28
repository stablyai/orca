import { runProcess } from '@orca/process-host'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
