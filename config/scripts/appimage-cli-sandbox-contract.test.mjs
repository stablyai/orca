import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import { parse, parseAllDocuments } from 'yaml'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { generateAppRunScript } = require('app-builder-lib/out/targets/appimage/appImageUtil')
const lockfile = parseAllDocuments(readFileSync('pnpm-lock.yaml', 'utf8'))
  .map((document) => document.toJS())
  .find((document) => document.patchedDependencies)
const workspace = parse(readFileSync('pnpm-workspace.yaml', 'utf8'))
const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

const appRun = generateAppRunScript({
  DesktopFileName: 'orca-ide.desktop',
  ExecutableName: 'orca-ide',
  ProductName: 'Orca',
  ProductFilename: 'Orca',
  ResourceName: 'appimagekit-orca-ide'
})

describe('AppImage CLI sandbox boundary', () => {
  it('limits generated sandbox fallback to Electron GUI mode', () => {
    expect(appRun).toContain(
      'if [ -z "${ELECTRON_RUN_AS_NODE-}" ] && [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then'
    )
    expect(appRun).toContain('exec "$BIN" "${NO_SANDBOX[@]}" "${args[@]}"')
  })

  it('pins the AppRun generator patch in the manifest and lockfile', () => {
    const patchPath = 'config/patches/app-builder-lib@26.15.3.patch'
    expect(workspace.patchedDependencies['app-builder-lib@26.15.3']).toBe(patchPath)
    expect(lockfile.patchedDependencies['app-builder-lib@26.15.3']).toMatch(/^[a-f0-9]{64}$/)
  })

  it('runs the packaged oracle after building the x64 AppImage', () => {
    const steps = workflow.jobs.package.steps
    const packageStep = steps.find((step) => step.name === 'Package unpacked app')
    const oracleStep = steps.find((step) => step.name === 'Verify AppImage CLI sandbox boundary')

    expect(packageStep.run).toContain('--linux AppImage --x64 --publish never')
    expect(oracleStep.run).toBe(
      'node config/scripts/run-appimage-cli-sandbox-docker.mjs --appimage dist/orca-linux.AppImage'
    )
    expect(steps.indexOf(oracleStep)).toBeGreaterThan(steps.indexOf(packageStep))
  })
})
