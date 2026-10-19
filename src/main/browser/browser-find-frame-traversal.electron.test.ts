import { runProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { build } from 'vite'
import { resolveElectronProbeLaunch } from './electron-probe-display-launch'

it('finishes and wraps guest searches in both directions beside host iframes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-find-traversal-'))
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        lib: {
          entry: join(__dirname, 'browser-find-frame-traversal-electron-fixture.ts'),
          formats: ['cjs'],
          fileName: () => 'main.cjs'
        },
        outDir: root,
        emptyOutDir: false,
        target: 'node22',
        rollupOptions: { external: ['electron', /^node:/] }
      }
    })
    const electronBinary: unknown = createRequire(import.meta.url)('electron')
    if (typeof electronBinary !== 'string') {
      throw new Error('Missing Electron executable')
    }
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
    const { executable, args } = resolveElectronProbeLaunch({
      electronBinary,
      electronArgs: [join(root, 'main.cjs'), `--user-data-dir=${join(root, 'profile')}`],
      platform: process.platform,
      display: env.DISPLAY
    })
    // A timeout inside Electron cannot fire when FindRequestManager blocks its main thread.
    const result = await runProcess({
      program: executable,
      args,
      env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 20_000,
      detached: process.platform !== 'win32',
      maxOutputBytes: 64 * 1024
    })
    expect(result.timedOut, result.stdout + result.stderr).toBe(false)
    expect(result.code, result.stdout + result.stderr).toBe(0)
    const line = result.stdout.split('\n').find((line) => line.startsWith('FIND_TRAVERSAL_RESULT:'))
    expect(line).toBeDefined()
    const evidence: unknown = JSON.parse(line?.slice('FIND_TRAVERSAL_RESULT:'.length) ?? 'null')
    expect(evidence).toEqual({
      electron: expect.any(String),
      hidden: true,
      results: ['before', 'after', 'both'].map((position) => ({
        position,
        results: (position === 'after' ? [false, true] : [true, false]).flatMap((forward) =>
          (forward ? [1, 2, 1, 2] : [2, 1, 2, 1]).map((ordinal) => ({
            forward,
            matches: 2,
            ordinal
          }))
        )
      }))
    })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 45_000)
