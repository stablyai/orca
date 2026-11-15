import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { resolveElectronProbeLaunch } from './electron-fixtures/electron-probe-display-launch'

it.each([false, true])(
  'redacts real Electron navigation warnings with trace=%s while preserving other diagnostics and page console',
  async (trace) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-kagi-warning-'))
    try {
      await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          emptyOutDir: false,
          lib: {
            entry: join(import.meta.dirname, 'electron-navigation-warning-redaction.ts'),
            formats: ['cjs'],
            fileName: () => 'sanitize.cjs'
          },
          outDir: root,
          target: 'node22',
          rollupOptions: { external: ['electron'] }
        }
      })
      const resultPath = join(root, 'result.json')
      const entry = join(root, 'main.cjs')
      writeFileSync(
        entry,
        `
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { installElectronNavigationWarningRedaction } = require('./sanitize.cjs');
installElectronNavigationWarningRedaction();
installElectronNavigationWarningRedaction();
app.setPath('userData', ${JSON.stringify(join(root, 'profile'))});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, partition: 'kagi-warning-control' } });
  const messages = [];
  win.webContents.on('console-message', event => messages.push(event.message));
  win.webContents.session.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.pathname === '/redirect-kagi') return Response.redirect('https://kagi.com/search?q=one&token=synthetic-native-secret', 302);
    if (url.searchParams.get('redirect') === 'result') return Response.redirect('https://kagi.com/result?q=one&token=synthetic-native-secret', 302);
    return new Response(null, { status: 204 });
  });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['https://kagi.com/*', 'https://example.com/*'] }, (event, done) => {
    const url = new URL(event.url);
    done({ cancel: url.pathname !== '/redirect-kagi' && url.searchParams.get('redirect') !== 'result' });
  });
  const errors = [];
  for (const url of ['https://kagi.com/search?q=one&token=synthetic-native-secret', 'https://example.com/control?token=ordinary-control', 'https://example.com/redirect-kagi', 'https://kagi.com/search?redirect=result&token=synthetic-native-secret']) {
    try { await win.loadURL(url); } catch (error) { errors.push(error.code); }
  }
  await win.loadURL('data:text/html,<script>console.log("In-app console stays intact")</script>');
  process.emitWarning('unrelated warning control', 'TestControl');
  await new Promise(resolve => setTimeout(resolve, 20));
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ messages, errors }));
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
`
      )
      const launch = resolveElectronProbeLaunch({
        electronBinary: createRequire(import.meta.url)('electron'),
        electronArgs: [...(trace ? ['--trace-warnings'] : []), entry],
        platform: process.platform,
        display: process.env.DISPLAY
      })
      const result = spawnSync(launch.executable, launch.args, {
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        encoding: 'utf8',
        timeout: 20_000
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).not.toContain('synthetic-native-secret')
      expect(result.stderr).toContain(
        'https://kagi.com/search?q=one with error: ERR_BLOCKED_BY_CLIENT'
      )
      expect(result.stderr).toContain(
        'https://example.com/control?token=ordinary-control with error: ERR_BLOCKED_BY_CLIENT'
      )
      expect(result.stderr).toContain(
        'https://kagi.com/result?q=one with error: ERR_BLOCKED_BY_CLIENT'
      )
      expect(result.stderr).toContain('unrelated warning control')
      const observed = JSON.parse(readFileSync(resultPath, 'utf8'))
      expect(observed.messages).toContain('In-app console stays intact')
      expect(observed.errors).toEqual([
        'ERR_BLOCKED_BY_CLIENT',
        'ERR_BLOCKED_BY_CLIENT',
        'ERR_BLOCKED_BY_CLIENT',
        'ERR_BLOCKED_BY_CLIENT'
      ])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
)
