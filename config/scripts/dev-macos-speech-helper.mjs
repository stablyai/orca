import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { getDevBundleProcessTable, isDevBundleInUse } from './dev-electron-bundle-cache.mjs'

export function createDevSpeechHelper({ repoRoot, appPath, distDir, markerPath }) {
  const script = path.join(repoRoot, 'config/scripts/build-speech-macos.mjs')
  const helper = path.join(appPath, 'Contents', 'MacOS', 'orca-speech')

  function build() {
    try {
      execFileSync(process.execPath, [script, '--single-arch', '--output', helper], {
        stdio: 'inherit'
      })
      return true
    } catch (error) {
      rmSync(helper, { force: true })
      console.warn(
        `[orca-dev] speech helper build failed (macOS native voice unavailable): ${error?.message ?? error}`
      )
      return false
    }
  }

  function retryIfMissing() {
    if (existsSync(helper)) {
      return
    }
    const processTable = getDevBundleProcessTable()
    const canRetry = processTable !== null && !isDevBundleInUse(distDir, processTable)
    if (canRetry && build()) {
      try {
        execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath])
      } catch (error) {
        rmSync(markerPath, { force: true })
        console.warn(`[orca-dev] ad-hoc codesign failed: ${error?.message ?? error}`)
      }
    }
  }

  return { build, retryIfMissing }
}
