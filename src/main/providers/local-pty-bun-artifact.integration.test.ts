import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'

const runtime =
  process.env.BUN_EXECUTABLE ?? resolve('out/orcad', orcadBunRuntimeFilename(process.platform))

describe.skipIf(!existsSync(runtime))('isolated Bun in-process PTY artifact', () => {
  it('spawns, reattaches, delivers data and retires a shell without node-pty installed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-bun-local-pty-'))
    try {
      const entry = join(directory, 'local-pty.cjs')
      const external = ['node-pty', 'electron', 'bun:ffi', '@parcel/watcher', '*.node']
      await build({
        stdin: {
          contents: `
            import { LocalPtyProvider } from './src/main/providers/local-pty-provider'
            import { setAppEnvironment } from './src/shared/app-environment'
            import { getCmdExePath } from './src/shared/windows-batch-spawn'
            try { require.resolve('node-pty'); throw new Error('node-pty unexpectedly available') }
            catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
            setAppEnvironment({
              getPath: () => process.cwd(), getAppPath: () => process.cwd(),
              getVersion: () => 'test', isPackaged: () => true,
              onWillQuit() {}, exit: code => process.exit(code), getAppMetrics: () => []
            })
            const provider = new LocalPtyProvider()
            let output = '', resolveExit
            const exit = new Promise(resolve => { resolveExit = resolve })
            provider.onData(event => { output += event.data })
            provider.onExit(event => resolveExit(event.code))
            const deadline = setTimeout(() => { provider.killAll(); process.exit(98) }, 10_000)
            ;(async () => {
              const first = await provider.spawn({
                sessionId: 'isolated-bun-fallback', cols: 80, rows: 24, cwd: process.cwd(),
                shellOverride: process.platform === 'win32' ? getCmdExePath() : '/bin/sh'
              })
              const again = await provider.spawn({sessionId:first.id, cols:100, rows:30})
              provider.write(first.id, process.platform === 'win32'
                ? 'echo ORCA_BUN_FALLBACK_READY & exit 17\\r'
                : 'printf ORCA_BUN_FALLBACK_READY; exit 17\\r')
              const code = await exit
              clearTimeout(deadline)
              console.log(JSON.stringify({
                version:process.versions.bun, code, output:output.includes('ORCA_BUN_FALLBACK_READY'),
                reattached:again.isReattach === true && again.pid === first.pid,
                retired:provider.getPtyProcess(first.id) === undefined
              }))
            })().catch(error => { clearTimeout(deadline); provider.killAll(); console.error(error);process.exitCode=1 })
          `,
          resolveDir: process.cwd(),
          loader: 'ts'
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        external,
        outfile: entry,
        logLevel: 'silent'
      })
      if (process.platform === 'win32') {
        await build({
          entryPoints: ['src/main/daemon/pty-subprocess/windows-bun-pty-gate-entry.ts'],
          bundle: true,
          platform: 'node',
          format: 'cjs',
          external,
          outfile: join(directory, 'windows-bun-pty-gate-entry.js'),
          logLevel: 'silent'
        })
      }
      const isolatedRuntime = join(directory, orcadBunRuntimeFilename(process.platform))
      await copyFile(runtime, isolatedRuntime)
      const result = await runProcess({
        program: isolatedRuntime,
        args: ['--no-install', entry],
        cwd: directory,
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
          ORCA_USER_DATA_PATH: directory
        },
        timeoutMs: 15_000,
        terminationBarrier: true
      })
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        version: ORCAD_BUN_VERSION,
        code: 17,
        output: true,
        reattached: true,
        retired: true
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
