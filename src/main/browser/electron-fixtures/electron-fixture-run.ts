import { runProcess } from '@orca/process-host'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { resolveElectronProbeLaunch } from './electron-probe-display-launch'

export type ElectronFixtureRun = Awaited<ReturnType<typeof runProcess>> & {
  /** The fixture's last stdout line, parsed as JSON; null when it printed none. */
  output: unknown
}

/** Bundles a main-process fixture and runs it in a real, background Electron. */
export async function runElectronFixture(
  entry: string,
  env: NodeJS.ProcessEnv = {}
): Promise<ElectronFixtureRun> {
  const root = await mkdtemp(join(tmpdir(), 'orca-electron-fixture-'))
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir: root,
        lib: { entry, formats: ['cjs'], fileName: () => 'main.cjs' },
        rollupOptions: { external: ['electron', /^node:/] },
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
      display: process.env.DISPLAY
    })
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env
    const result = await runProcess({
      program: executable,
      args,
      env: { ...inherited, ...env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 45_000
    })
    let output: unknown = null
    try {
      output = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')
    } catch {}
    return { ...result, output }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
