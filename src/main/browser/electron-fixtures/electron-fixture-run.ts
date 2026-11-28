import { runProcess } from '@orca/process-host'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { build } from 'vite'
import { resolveElectronProbeLaunch } from './electron-probe-display-launch'
import {
  ELECTRON_FIXTURE_PRIVATE_DISPLAY_ENV,
  ELECTRON_FIXTURE_RESULT_ENV
} from './electron-fixture-result'

export type ElectronFixtureRun = Awaited<ReturnType<typeof runProcess>> & {
  /** What the fixture passed to `writeElectronFixtureResult`; null when it wrote none. */
  output: unknown
}

/** Bundles a main-process fixture and runs it in a real, background Electron. */
export async function runElectronFixture(
  entry: string,
  env: NodeJS.ProcessEnv = {},
  options: { isolatedEnvironment?: boolean } = {}
): Promise<ElectronFixtureRun> {
  // Inside the repo, so a package the bundle leaves external resolves from its node_modules.
  const cache = join(import.meta.dirname, '../../../../node_modules/.cache')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'orca-electron-fixture-'))
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      // A Node build: builtins stay external and packages resolve their Node entries, not browser stubs.
      ssr: { noExternal: true },
      build: {
        outDir: root,
        ssr: entry,
        rollupOptions: {
          external: ['electron'],
          output: { format: 'cjs', entryFileNames: 'main.cjs' }
        },
        target: 'node24'
      }
    })
    const electronBinary: unknown = createRequire(import.meta.url)('electron')
    if (typeof electronBinary !== 'string') {
      throw new Error('Electron binary path unavailable')
    }
    const { executable, args } = resolveElectronProbeLaunch({
      electronBinary,
      electronArgs: [join(root, 'main.cjs'), `--user-data-dir=${join(root, 'profile')}`],
      platform: process.platform,
      display: process.env.DISPLAY,
      // Fixtures show their window on Linux (see letFixtureWindowPaint), so they get their own Xvfb display.
      privateDisplay: true
    })
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env
    const baseEnvironment = options.isolatedEnvironment
      ? Object.fromEntries(
          Object.entries(inherited).filter(([key]) =>
            [
              'PATH',
              'Path',
              'SystemRoot',
              'WINDIR',
              'ComSpec',
              'PATHEXT',
              'LANG',
              'LC_ALL',
              'LC_CTYPE',
              // Linux runs under its own xvfb-run, which sets these; elsewhere they are unused.
              ...(process.platform === 'linux' ? [] : ['DISPLAY', 'XAUTHORITY'])
            ].includes(key)
          )
        )
      : inherited
    if (options.isolatedEnvironment) {
      if (!env.HOME) {
        throw new Error('Isolated fixture requires its own HOME')
      }
      await mkdir(join(root, 'tmp'), { recursive: true })
      Object.assign(baseEnvironment, {
        TMPDIR: join(root, 'tmp'),
        TEMP: join(root, 'tmp'),
        TMP: join(root, 'tmp'),
        USERPROFILE: env.HOME,
        APPDATA: join(env.HOME, 'appData'),
        LOCALAPPDATA: join(env.HOME, 'localAppData'),
        XDG_CACHE_HOME: join(env.HOME, 'cache')
      })
    }
    const resultPath = join(root, 'result.json')
    const result = await runProcess({
      program: executable,
      args,
      env: {
        ...baseEnvironment,
        ...env,
        ORCA_BACKGROUND_LAUNCH: '1',
        [ELECTRON_FIXTURE_PRIVATE_DISPLAY_ENV]: '1',
        [ELECTRON_FIXTURE_RESULT_ENV]: resultPath
      },
      timeoutMs: 45_000
    })
    let output: unknown = null
    try {
      output = JSON.parse(await readFile(resultPath, 'utf8'))
    } catch {}
    return { ...result, output }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
