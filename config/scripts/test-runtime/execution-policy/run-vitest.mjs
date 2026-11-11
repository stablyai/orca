import os from 'node:os'
import { resolve } from 'node:path'
import { runProcess, runProcessSync, spawnProcess } from '@orca/process-host'
import { hasNoChangedFiles } from './vitest-changed-precheck.mjs'
import { RUN_ARGS_ENV } from './vitest-run-filters.mjs'
import { localModuleCacheEnv } from '../module-cache/vitest-local-module-cache.mjs'
import { createRunTempDirectory } from './vitest-run-temp-directory.mjs'
import { createVitestZodBundle } from '../module-cache/vitest-zod-bundle.mjs'
import { delegateHostValidation } from '../../preflight/host-validation/host-validation-budget.mjs'
import {
  checkBunVersion,
  probeBunVersion,
  readPinnedBunVersion,
  resolvePinnedBunExecutable
} from '../../tool-invocation/pinned-bun-executable.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const vitestArgs = process.argv.slice(2)
if (process.env.ORCA_VALIDATION_TOKEN) {
  let workers = 2
  for (let index = vitestArgs.length - 1; index >= 0; index--) {
    const argument = vitestArgs[index]
    if (/^--max-?workers(?:=|$)/i.test(argument)) {
      const value = argument.includes('=') ? argument.split('=')[1] : vitestArgs[index + 1]
      const count = value?.endsWith('%')
        ? Math.ceil((os.availableParallelism() * Number(value.slice(0, -1))) / 100)
        : Number(value)
      workers = Math.min(workers, count)
      vitestArgs.splice(index, argument.includes('=') ? 1 : 2)
    }
  }
  vitestArgs.push(`--maxWorkers=${workers}`)
}

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

function waitForVitest(spec) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(spec)
    // Stay alive until Vitest exits so the run directory is removed after its last write.
    // A terminal sends SIGINT and SIGHUP to the whole group; forward them only if Vitest missed them.
    const forward = (signal) => {
      if (signal === 'SIGTERM') {
        child.kill(signal)
        return
      }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill(signal)
        }
      }, 1000).unref()
    }
    for (const signal of FORWARDED_SIGNALS) {
      process.on(signal, forward)
    }
    const settle = () => {
      for (const signal of FORWARDED_SIGNALS) {
        process.off(signal, forward)
      }
    }
    child.on('error', (error) => {
      settle()
      reject(error)
    })
    child.on('close', (code, signal) => {
      settle()
      resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1))
    })
  })
}

async function runVitest() {
  const pinnedBun = resolvePinnedBunExecutable(root, runProcessSync)
  const bunCheck = pinnedBun
    ? { ok: true }
    : checkBunVersion(probeBunVersion('bun', root, runProcessSync), readPinnedBunVersion(root))
  if (bunCheck.message) {
    console.error(bunCheck.message)
  }
  if (!bunCheck.ok) {
    return 1
  }
  let runTemp
  try {
    const zodBundle = createVitestZodBundle(root)
    const moduleCacheEnv = await localModuleCacheEnv(root)
    runTemp = createRunTempDirectory()
    return await waitForVitest({
      program: pinnedBun ?? 'bun',
      args: ['--bun', resolve(root, 'node_modules/vitest/vitest.mjs'), ...vitestArgs],
      cwd: root,
      env: {
        ...process.env,
        ...runTemp?.env,
        ...moduleCacheEnv,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_TEST_NODE_EXECUTABLE: process.execPath,
        ORCA_TEST_NODE_VERSION: process.versions.node,
        ORCA_UNIT_ZOD_BUNDLE: zodBundle.path,
        [RUN_ARGS_ENV]: JSON.stringify(vitestArgs),
        // The config's TypeScript and CommonJS package scope are intended; the notice is noise.
        VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true'
      },
      stdio: 'inherit'
    })
  } catch (error) {
    console.error('Could not prepare or start Vitest:', error)
    return 1
  } finally {
    runTemp?.remove()
  }
}

if (!(await delegateHostValidation())) {
  if (await hasNoChangedFiles(vitestArgs, root, runProcess)) {
    // Vitest's own result for this case, without paying its startup.
    console.log('No changed files found, exiting with code 0')
  } else {
    process.exitCode = await runVitest()
  }
}
