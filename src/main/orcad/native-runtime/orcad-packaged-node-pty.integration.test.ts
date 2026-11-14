import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { mkdtemp, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { ORCAD_NODE_PTY_DIR } from '../../../shared/orcad-artifacts'
import { removeTreeSync } from '../../../shared/windows-transient-lock-removal'
import {
  locatePinnedNodeForTests,
  skipForMissingInputs
} from '../testing/native-slots/orcad-node-slot-fixture'

const packageDir = resolve('out/orcad')
const pinnedNode = locatePinnedNodeForTests()

const skip = skipForMissingInputs('artifact', [
  ...(pinnedNode ? [] : ['the pinned Node (ORCA_PINNED_NODE or out/runtimes)']),
  ...(existsSync(join(packageDir, ORCAD_NODE_PTY_DIR)) ? [] : [`out/orcad/${ORCAD_NODE_PTY_DIR}`])
])

describe.skipIf(skip)('packaged node-pty under the pinned Node', () => {
  it('spawns a shell and delivers its output and exit from the shipped slot only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-packaged-node-pty-'))
    try {
      const entry = join(directory, 'local-pty.cjs')
      // Dynamic ESM imports ignore NODE_PATH.
      await symlink(join(packageDir, 'node_modules'), join(directory, 'node_modules'), 'junction')
      await build({
        stdin: {
          contents: `
              import { LocalPtyProvider } from './src/main/providers/local-pty/local-pty-provider'
              import { setAppEnvironment } from './src/shared/app-environment'
              import { getCmdExePath } from './src/shared/windows-batch-spawn'
              const loaded = require('fs').realpathSync(require.resolve('node-pty'))
              if (!loaded.startsWith(require('fs').realpathSync(${JSON.stringify(packageDir)}))) throw new Error('node-pty resolved outside the package: ' + loaded)
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
                  sessionId: 'packaged-node-pty', cols: 80, rows: 24, cwd: process.cwd(),
                  shellOverride: process.platform === 'win32' ? getCmdExePath() : '/bin/sh'
                })
                provider.write(first.id, process.platform === 'win32'
                  ? 'echo ORCA_PACKAGED_PTY_READY & exit 17\\r'
                  : 'printf ORCA_PACKAGED_PTY_READY; exit 17\\r')
                const code = await exit
                clearTimeout(deadline)
                console.log(JSON.stringify({
                  code, output: output.includes('ORCA_PACKAGED_PTY_READY')
                }))
              })().catch(error => { clearTimeout(deadline); provider.killAll(); console.error(error); process.exitCode = 1 })
            `,
          resolveDir: process.cwd(),
          loader: 'ts'
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        external: ['node-pty', 'electron', '@parcel/watcher', '*.node'],
        outfile: entry,
        logLevel: 'silent'
      })
      const result = await runProcess({
        program: pinnedNode!,
        args: [entry],
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
        code: 17,
        output: true
      })
    } finally {
      // Remove the junction before recursively deleting the test root.
      await unlink(join(directory, 'node_modules')).catch(() => {})
      removeTreeSync(directory)
    }
  }, 20_000)
})
