import { spawnProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { build } from 'vite'
import { waitForBrowserCdpEndpoint } from './browser-session-ua-cdp-collector'
import { resolveElectronProbeLaunch } from './electron-probe-display-launch'

export function createPopupIdentityProbeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'orca-popup-identity-'))
}

export async function buildPopupIdentityProbe(
  root: string,
  entry: string,
  fileName: string,
  renderer = false
): Promise<void> {
  await build({
    configFile: false,
    logLevel: 'silent',
    oxc: { jsx: { development: false } },
    resolve: { alias: { '@': join(process.cwd(), 'src/renderer/src') } },
    define: {
      ORCA_FEATURE_WALL_ENABLED: 'true',
      ORCA_BUILD_COMMIT: JSON.stringify('0'.repeat(40)),
      'import.meta.env.DEV': 'false',
      'process.env.NODE_ENV': JSON.stringify('production')
    },
    build: {
      emptyOutDir: false,
      lib: {
        entry,
        formats: [renderer ? 'iife' : 'cjs'],
        name: 'PopupIdentityProbe',
        fileName: () => fileName
      },
      outDir: root,
      target: renderer ? 'chrome140' : 'node22',
      rollupOptions: {
        external: renderer ? [] : ['electron', /^node:/],
        output: { inlineDynamicImports: true }
      }
    }
  })
}

export async function launchPopupIdentityProbe(root: string, electronArgs: readonly string[] = []) {
  const portServer = createServer()
  await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve))
  const address = portServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing probe port')
  }
  const port = address.port
  await new Promise<void>((resolve) => portServer.close(() => resolve()))
  const electronBinary: unknown = createRequire(import.meta.url)('electron')
  if (typeof electronBinary !== 'string') {
    throw new Error('Missing Electron executable')
  }
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  const { executable, args } = resolveElectronProbeLaunch({
    electronBinary,
    electronArgs: [
      ...electronArgs,
      join(root, 'main.cjs'),
      `--user-data-dir=${join(root, 'profile')}`,
      `--remote-debugging-port=${port}`
    ],
    platform: process.platform,
    display: env.DISPLAY
  })
  const child = spawnProcess({
    program: executable,
    args,
    env: { ...env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_POPUP_IDENTITY_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const diagnostics: string[] = []
  child.stderr?.on('data', (data: Buffer) => diagnostics.push(data.toString()))
  try {
    await waitForBrowserCdpEndpoint(port)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    return {
      browser,
      diagnostics,
      stop: async (): Promise<void> => {
        await browser.close()
        child.kill()
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve()
          } else {
            child.once('exit', () => resolve())
          }
        })
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  } catch (error) {
    child.kill()
    throw new Error(`${String(error)}\n${diagnostics.join('')}`)
  }
}
