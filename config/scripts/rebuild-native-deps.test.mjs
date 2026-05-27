import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceScriptPath = fileURLToPath(new URL('./rebuild-native-deps.mjs', import.meta.url))

describe('rebuild-native-deps Electron install fallback', () => {
  it('continues non-strict postinstall when Electron retry download fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir, { installExitsWith: 1 })
      writeFakeElectronRebuild(projectDir)

      const result = runRebuildScript(projectDir, {
        npm_lifecycle_event: 'postinstall',
        ORCA_STRICT_ELECTRON_INSTALL: ''
      })

      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).toContain('Electron install retry failed')
      expect(result.stderr).toContain('Continuing postinstall because Electron binary installation failed')
      expect(readFileSync(join(projectDir, 'electron-install.log'), 'utf8')).toBe('install attempted\n')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('fails strict postinstall when Electron retry download fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir, { installExitsWith: 1 })
      writeFakeElectronRebuild(projectDir)

      const result = runRebuildScript(projectDir, {
        npm_lifecycle_event: 'postinstall',
        ORCA_STRICT_ELECTRON_INSTALL: '1'
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Electron install retry failed')
      expect(result.stderr).not.toContain('Continuing postinstall because Electron binary installation failed')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('fails non-postinstall rebuild commands when Electron retry download fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir, { installExitsWith: 1 })
      writeFakeElectronRebuild(projectDir)

      const result = runRebuildScript(projectDir)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Electron install retry failed')
      expect(result.stderr).not.toContain('Continuing postinstall because Electron binary installation failed')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('clears partial Electron package contents before retrying install', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir, {
        installExitsWith: 1,
        logPartialStateBeforeInstall: true
      })
      writeFakeElectronRebuild(projectDir)
      mkdirSync(join(projectDir, 'node_modules', 'electron', 'dist', 'locales'), { recursive: true })
      writeFileSync(join(projectDir, 'node_modules', 'electron', 'dist', 'locales', 'stale.pak'), '')
      writeFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'stale-path')

      const result = runRebuildScript(projectDir, {
        ORCA_STRICT_ELECTRON_INSTALL: '1'
      })

      expect(result.status).toBe(1)
      expect(readFileSync(join(projectDir, 'electron-install.log'), 'utf8')).toBe(
        'partial cleared\ninstall attempted\n'
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

function mkTempProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'orca-rebuild-native-deps-'))
  mkdirSync(join(projectDir, 'config', 'scripts'), { recursive: true })
  copyFileSync(sourceScriptPath, join(projectDir, 'config', 'scripts', 'rebuild-native-deps.mjs'))
  return projectDir
}

function runRebuildScript(projectDir, extraEnv = {}) {
  return spawnSync(process.execPath, ['config/scripts/rebuild-native-deps.mjs'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv
    }
  })
}

function writeFakeElectronPackage(
  projectDir,
  { installExitsWith, logPartialStateBeforeInstall = false }
) {
  const electronDir = join(projectDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(join(electronDir, 'package.json'), JSON.stringify({ version: '41.5.0' }))
  writeFileSync(
    join(electronDir, 'index.js'),
    "throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again')\n"
  )
  writeFileSync(
    join(electronDir, 'install.js'),
    `
const { appendFileSync, existsSync } = require('node:fs')
if (${JSON.stringify(logPartialStateBeforeInstall)}) {
  appendFileSync(
    'electron-install.log',
    existsSync('node_modules/electron/dist') || existsSync('node_modules/electron/path.txt')
      ? 'partial still present\\n'
      : 'partial cleared\\n'
  )
}
appendFileSync('electron-install.log', 'install attempted\\n')
process.exit(${installExitsWith})
`
  )
  chmodSync(join(electronDir, 'install.js'), 0o755)
}

function writeFakeElectronRebuild(projectDir) {
  const rebuildDir = join(projectDir, 'node_modules', '@electron', 'rebuild')
  mkdirSync(rebuildDir, { recursive: true })
  writeFileSync(join(rebuildDir, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(rebuildDir, 'index.js'), 'export async function rebuild() {}\n')
}
