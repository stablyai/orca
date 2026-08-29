import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const requiredFiles = [
  'src-tauri/Cargo.toml',
  'src-tauri/tauri.conf.json',
  'src-tauri/src/main.rs',
  'src-tauri/src/lib.rs',
  'src/desktop-host/desktop-host-entry.ts',
  'src/renderer/src/desktop/main.tsx',
  'vite.desktop.config.ts'
]

const missing = requiredFiles.filter((file) => !existsSync(path.join(repoRoot, file)))
if (missing.length > 0) {
  console.error('[verify-tauri-desktop] missing files:')
  for (const file of missing) {
    console.error(`  - ${file}`)
  }
  process.exit(1)
}

const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
if (
  String(packageJson.scripts.dev).includes('electron-vite') ||
  String(packageJson.scripts.dev).includes('ensure:electron-runtime')
) {
  console.error('[verify-tauri-desktop] pnpm run dev still launches Electron')
  process.exit(1)
}
if (
  String(packageJson.scripts.start).includes('electron-vite') ||
  String(packageJson.scripts.start).includes('ensure:electron-runtime')
) {
  console.error('[verify-tauri-desktop] pnpm start still launches Electron')
  process.exit(1)
}

const cargo = readFileSync(path.join(repoRoot, 'src-tauri/Cargo.toml'), 'utf8')
if (!/tauri = \{ version = "=?2/.test(cargo)) {
  console.error('[verify-tauri-desktop] src-tauri is not a Tauri v2 crate')
  process.exit(1)
}

const tauriConf = JSON.parse(readFileSync(path.join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'))
if (!tauriConf.build?.devUrl || !String(tauriConf.build.devUrl).includes('5174')) {
  console.error('[verify-tauri-desktop] Tauri window is not pointed at the desktop renderer')
  process.exit(1)
}

console.log('[verify-tauri-desktop] Tauri/Pake desktop host project is present')
