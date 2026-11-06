// Run the desktop launcher outside Electron so tests can choose its runtime and the daemon's.
import { build, type Plugin } from 'esbuild'
import { mkdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { readDaemonPidRecord } from '../../endpoint/identity/daemon-endpoint-incarnation'
import { getDaemonPidPath } from '../daemon-spawner'
import { killChildAndWait } from '../../../orcad/orcad-daemon-teardown-fixture'

export type DaemonLauncherDriverResult = { adopted: boolean; mode: string | null }

export type LauncherWindow = {
  result: DaemonLauncherDriverResult
  stderr: () => string
  quit: () => Promise<void>
}

const requireFromFixture = createRequire(import.meta.url)
const QUIT_GRACE_MS = 10_000
// Every launcher still running, so a failed test cannot leave one waiting on its stdin.
const openWindows = new Set<ReturnType<typeof spawnProcess>>()
const NATIVE_EXTERNALS = ['electron', 'node-pty', '@parcel/watcher', '*.node']

// Simulate AppImage detection; the remaining launch path is real.
const simulatedAppImageRuntime: Plugin = {
  name: 'simulated-appimage-runtime',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\/appimage-runtime-identity$/ }, () => ({
      path: 'appimage-runtime-identity',
      namespace: 'simulated'
    }))
    pluginBuild.onLoad({ filter: /.*/, namespace: 'simulated' }, () => ({
      contents: `
        export function resolveAppImageRuntimeIdentity({ environment = process.env } = {}) {
          return environment.APPIMAGE && environment.APPDIR ? { appImagePath: environment.APPIMAGE } : null
        }
        export function hasAppImagePathEnvironment(environment = process.env) {
          return Boolean(environment.APPIMAGE)
        }`,
      loader: 'js'
    }))
  }
}

/** Prints one JSON result; closing piped stdin disconnects the launcher without stopping the daemon. */
export async function buildDaemonLauncherDriver(
  outfile: string,
  options: { simulateAppImageRuntime?: boolean } = {}
): Promise<void> {
  await build({
    stdin: {
      contents: `\n        import { mkdirSync } from 'node:fs'\n        import { join } from 'node:path'\n        import { createOutOfProcessLauncher } from './src/main/daemon/launch/daemon-out-of-process-launcher'\n        import { getDaemonSocketPath, getDaemonTokenPath } from './src/main/daemon/launch/daemon-spawner'\n        import { setAppEnvironment } from './src/shared/app-environment'\n        const [userData, appPath, version] = process.argv.slice(2)\n        setAppEnvironment({\n          getPath: () => userData, getAppPath: () => appPath, getVersion: () => version,\n          isPackaged: () => true, onWillQuit() {}, exit: code => process.exit(code),\n          getAppMetrics: () => []\n        })\n        const runtimeDir = join(userData, 'daemon')\n        mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })\n        createOutOfProcessLauncher(runtimeDir)(getDaemonSocketPath(runtimeDir), getDaemonTokenPath(runtimeDir))\n          .then(handle => {\n            console.log(JSON.stringify({ adopted: handle.adopted === true, mode: handle.mode ?? null }))\n            process.stdin.on('end', () => process.exit(0))\n            process.stdin.resume()\n          })\n          .catch(error => { console.error(error); process.exit(1) })\n      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: NATIVE_EXTERNALS,
    plugins: options.simulateAppImageRuntime ? [simulatedAppImageRuntime] : [],
    outfile,
    logLevel: 'silent'
  })
}

/** The daemon entry at `<outDir>/main/daemon-entry.js`, with node-pty where a package keeps it. */
export async function installDaemonEntry(outDir: string, nodeModulesDir: string): Promise<void> {
  await build({
    entryPoints: [join(__dirname, '../../daemon-entry.ts')],
    outfile: join(outDir, 'main', 'daemon-entry.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: NATIVE_EXTERNALS,
    logLevel: 'silent'
  })
  mkdirSync(nodeModulesDir, { recursive: true })
  symlinkSync(
    dirname(realpathSync(requireFromFixture.resolve('node-pty/package.json'))),
    join(nodeModulesDir, 'node-pty')
  )
}

/** Without Vitest's markers: daemon-entry does not start its server under VITEST. */
export function daemonTestEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST') && key !== 'NODE_ENV')
    ),
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  return { ...env, ...extra }
}

/** Keep the launcher connected like an open window until quit. */
export async function openLauncherWindow(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<LauncherWindow> {
  const child = spawnProcess({ program, args, env, stdio: ['pipe', 'pipe', 'pipe'] })
  openWindows.add(child)
  const exited = new Promise<void>((settle) =>
    child.once('exit', () => {
      openWindows.delete(child)
      settle()
    })
  )
  let stdout = ''
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  let result: DaemonLauncherDriverResult
  try {
    const line = await new Promise<string>((settle, reject) => {
      const timer = setTimeout(() => reject(new Error(`launcher timed out: ${stderr}`)), 60_000)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        const newline = stdout.indexOf('\n')
        if (newline !== -1) {
          clearTimeout(timer)
          settle(stdout.slice(0, newline))
        }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`launcher exited ${code}: ${stderr}`))
      })
    })
    result = JSON.parse(line)
  } catch (error) {
    await killChildAndWait(child)
    throw error
  }
  return {
    result,
    stderr: () => stderr,
    quit: async () => {
      child.stdin?.end()
      const grace = new Promise<void>((settle) => setTimeout(settle, QUIT_GRACE_MS).unref())
      await Promise.race([exited, grace])
      await killChildAndWait(child)
    }
  }
}

/** Stops every launcher a test left open; for `afterEach`, before its daemons are killed. */
export async function closeLauncherWindows(): Promise<void> {
  await Promise.all([...openWindows].map((child) => killChildAndWait(child)))
}

export function profileDaemonPid(userData: string): number | null {
  return readDaemonPidRecord(getDaemonPidPath(join(userData, 'daemon')))?.pid ?? null
}

export function profileDaemonEntryIdentity(userData: string): string | null {
  return readDaemonPidRecord(getDaemonPidPath(join(userData, 'daemon')))?.entryPath ?? null
}

/** Linux only: the real executable a process runs. */
export function executableOf(pid: number): string {
  return realpathSync(readlinkSync(`/proc/${pid}/exe`))
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
