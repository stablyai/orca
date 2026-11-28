// Rolldown evaluates shared chunks before index.js's first import, so the layout owner is resolved in
// its banner: the switch module reads it as a const and must never see a later value.
import type { Plugin } from 'vite'
import {
  LAYOUT_OWNER_ENV,
  LAYOUT_OWNER_FLAG_DIR_KEY,
  LAYOUT_OWNER_FLAG_FILE_NAME,
  LAYOUT_OWNER_RESOLVED_ENV,
  SERVER_LAYOUT_OWNER_ENV
} from '../../src/shared/workspace-layout/layout-owner-startup'

const MARKER = '/* orca: resolve layout owner */'

/** Same rules as resolveHostLayoutOwner (src/main/layout-owner/host-layout-owner.ts). */
export function createLayoutOwnerBanner(): string {
  return `${MARKER}
;(() => {
  const env = process.env
  const server = process.argv.includes('--serve') || env.ORCA_ORCAD_SIDECAR === '1'
  const name = server ? ${JSON.stringify(SERVER_LAYOUT_OWNER_ENV)} : ${JSON.stringify(LAYOUT_OWNER_ENV)}
  let raw = env[name] || undefined
  let source = name
  if (raw === undefined && !server) {
    source = ${JSON.stringify(LAYOUT_OWNER_FLAG_FILE_NAME)}
    try {
      const path = require('node:path')
      const { app } = require('electron')
      // Windows: read APPDATA directly; Electron's provider can crash this early without a user profile.
      const appData = () => {
        if (process.platform !== 'win32') return app.getPath('appData')
        if (env.APPDATA && path.win32.isAbsolute(env.APPDATA)) return env.APPDATA
        return path.win32.join(env.USERPROFILE, 'AppData', 'Roaming')
      }
      // The userData configureDevUserDataPath picks later, before Electron's own default.
      let dir = env.ORCA_E2E_USER_DATA_DIR
      if (!dir && !app.isPackaged) dir = env.ORCA_DEV_USER_DATA_PATH || path.join(appData(), 'orca-dev')
      if (!dir) dir = process.platform === 'win32' ? path.win32.join(appData(), app.getName()) : app.getPath('userData')
      globalThis[${JSON.stringify(LAYOUT_OWNER_FLAG_DIR_KEY)}] = dir
      raw = require('node:fs').readFileSync(path.join(dir, source), 'utf8')
    } catch {}
  }
  const word = typeof raw === 'string' ? raw.trim() : undefined
  const owner = word === 'main' || word === 'window' ? word : 'window'
  if (raw !== undefined && owner !== word) {
    console.warn('[layout-owner] unknown ' + source + ' value ' + JSON.stringify(raw) + '; using the window path')
  }
  if (server) delete env[${JSON.stringify(LAYOUT_OWNER_ENV)}]
  env[${JSON.stringify(LAYOUT_OWNER_RESOLVED_ENV)}] = owner
})();
`
}

/** Whether the resolution runs before index.js loads any chunk (a chunk can hold the switch module). */
export function resolvesLayoutOwnerBeforeModules(code: string): boolean {
  const marker = code.indexOf(MARKER)
  const firstRequire = code.search(/require\(["']\.\.?\//)
  return marker !== -1 && (firstRequire === -1 || marker < firstRequire)
}

export function createLayoutOwnerBannerGuardPlugin(): Plugin {
  return {
    name: 'orca-layout-owner-banner-guard',
    generateBundle(_options, bundle) {
      const chunk = bundle['index.js']
      if (chunk?.type === 'chunk' && !resolvesLayoutOwnerBeforeModules(chunk.code)) {
        throw new Error('index.js must resolve the layout owner before it loads any module')
      }
    }
  }
}
