import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { spawnProcess } from '../../src/shared/child-process/run-process.ts'

const mobileRoot = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const expoCliPath = require.resolve('expo/bin/cli')

export function createHostMobileWebExportProcessSpec({
  environment = process.env,
  expoCli = expoCliPath,
  mobileDirectory = mobileRoot,
  nodeExecutable = process.execPath,
  outputDirectory
}) {
  return {
    program: nodeExecutable,
    args: [expoCli, 'export', '--platform', 'web', '--output-dir', outputDirectory],
    cwd: mobileDirectory,
    env: {
      ...environment,
      NODE_ENV: 'production',
      ORCA_EXPO_ROUTER_ROOT: 'host-web-app'
    }
  }
}

export async function runHostMobileWebExport({
  environment = process.env,
  mobileDirectory = mobileRoot,
  outputDirectory,
  platform = process.platform,
  spawn = spawnProcess,
  stderr = process.stderr,
  stdout = process.stdout
}) {
  const child = spawn(
    createHostMobileWebExportProcessSpec({
      environment,
      mobileDirectory,
      outputDirectory,
      platform
    })
  )
  child.stdout?.pipe(stdout)
  child.stderr?.pipe(stderr)
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on('error', () => {})
  }
  child.stdin?.end()

  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, exitSignal) => {
      resolve({ code: exitCode, signal: exitSignal })
    })
  })
  if (signal) {
    stderr.write(`Expo web export terminated by ${signal}\n`)
    return 1
  }
  return code ?? 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const outputArgument = process.argv.slice(2).find((value) => value !== '--')
  const outputDirectory = path.resolve(mobileRoot, outputArgument ?? '../out/mobile-web-rnw-proof')

  try {
    process.exitCode = await runHostMobileWebExport({ outputDirectory })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
