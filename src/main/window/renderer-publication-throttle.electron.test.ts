import { runProcess } from '@orca/process-host'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { build } from 'vite'
import { resolveElectronProbeLaunch } from '../browser/electron-probe-display-launch'

describe('publication lease release during Electron guest destruction', () => {
  it('closes streamed guests without terminating the host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-throttle-destruction-'))
    try {
      await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          outDir: root,
          lib: {
            entry: join(import.meta.dirname, 'renderer-publication-throttle-electron-fixture.ts'),
            formats: ['cjs'],
            fileName: () => 'main.cjs'
          },
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
      const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
      const result = await runProcess({
        program: executable,
        args,
        env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 45_000
      })
      expect(result.timedOut).toBe(false)
      expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
      const output: unknown = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')
      expect(output).toEqual({
        frames: expect.any(Number),
        releasesDuringDestruction: 3,
        restoreCalls: 0,
        captureCalls: 0,
        title: 'Host is still reachable'
      })
      expect(output).toHaveProperty(
        'frames',
        expect.toSatisfy((frames: number) => frames >= 3)
      )
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 60_000)
})
