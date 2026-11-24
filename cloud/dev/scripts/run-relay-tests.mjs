import { runProcess } from '@orca/process-host'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const relayDirectory = fileURLToPath(new URL('../../apps/relay', import.meta.url))

export async function runRelayTests({
  args = [],
  cwd = relayDirectory,
  env = process.env,
  parallelism = availableParallelism(),
  cli = vitest,
  run = runProcess,
  events = process,
  report = console.error,
  scratchParent = tmpdir()
} = {}) {
  const workerBudget = Math.max(parallelism - 1, 1)
  // Explicit selectors and alternate database fixtures retain their existing execution path.
  const serial =
    args.length > 0 || workerBudget <= 1 || env.ORCA_IDLE_REHOME_POSTGRES_URL || env.DATABASE_URL
  const roles = serial
    ? [{ name: 'all', args }]
    : [
        { name: 'relay', args: ['--project=relay', `--maxWorkers=${workerBudget - 1}`] },
        { name: 'relay-postgres', args: ['--project=relay-postgres', '--maxWorkers=1'] }
      ]
  const scratch = realpathSync(mkdtempSync(join(scratchParent, 'orca-relay-tests-')))
  const abort = new AbortController()
  const closed = new Set()
  const terminatedTrees = new Set()
  let signalExitCode
  const onInterrupt = () => {
    signalExitCode ??= 130
    abort.abort()
  }
  const onTerminate = () => {
    signalExitCode ??= 143
    abort.abort()
  }
  events.on('SIGINT', onInterrupt)
  events.on('SIGTERM', onTerminate)

  async function runRole(role) {
    const owned = join(scratch, role.name)
    try {
      mkdirSync(owned)
      return await run({
        program: process.execPath,
        args: [cli, 'run', ...role.args],
        cwd,
        env: {
          ...env,
          TMPDIR: owned,
          TMP: owned,
          TEMP: owned,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_RELAY_TEST_CACHE_DIR: join(owned, 'cache')
        },
        stdio: 'inherit',
        timeoutMs: null,
        signal: abort.signal,
        terminationBarrier: {
          async signal(child, signal) {
            const terminated = await signalProcessTree(child, signal)
            if (process.platform === 'win32' && terminated) {
              terminatedTrees.add(role.name)
            }
            return terminated
          },
          async force(child) {
            const terminated = await forceTerminateProcessTree(child)
            if (terminated) {
              terminatedTrees.add(role.name)
            }
            return terminated
          }
        },
        onChildTerminated: () => closed.add(role.name)
      })
    } catch (error) {
      abort.abort()
      throw error
    }
  }

  let exitCode = 0
  try {
    const results = await Promise.allSettled(roles.map(runRole))
    for (const result of results) {
      if (result.status === 'rejected') {
        report(result.reason)
        exitCode ||= 1
      } else if (result.value.code !== 0 || result.value.signal || result.value.timedOut) {
        exitCode ||= result.value.code || 1
      }
    }
  } finally {
    events.removeListener('SIGINT', onInterrupt)
    events.removeListener('SIGTERM', onTerminate)
    // A cancelled root's close event alone does not prove its descendants stopped using scratch.
    if (
      closed.size === roles.length &&
      (!abort.signal.aborted || terminatedTrees.size === roles.length)
    ) {
      rmSync(scratch, { recursive: true, force: true })
    } else {
      report(`Relay test process closure is unverifiable; retained ${scratch}`)
      exitCode ||= 1
    }
  }
  return signalExitCode ?? exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runRelayTests({ args: process.argv.slice(2) })
}
