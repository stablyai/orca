import { readFileSync } from 'node:fs'
import { findBundledMainFile } from '../../bundled-main-file-path'
import {
  BROWSER_EXTENSION_CONTENT_SCRIPT_FILE,
  BROWSER_EXTENSION_WORKER_SHIM_FILE
} from '../../../../shared/browser/extensions/browser-extension-worker-api'

const scripts = new Map<string, string>()

function readBundledScript(fileName: string): string {
  let script = scripts.get(fileName)
  if (script === undefined) {
    const path = findBundledMainFile(fileName)
    if (!path) {
      throw new Error(`Orca’s ${fileName} is missing from this build`)
    }
    script = readFileSync(path, 'utf8')
    scripts.set(fileName, script)
  }
  return script
}

export function readBrowserExtensionWorkerShim(): string {
  return readBundledScript(BROWSER_EXTENSION_WORKER_SHIM_FILE)
}

export function readBrowserExtensionContentScript(): string {
  return readBundledScript(BROWSER_EXTENSION_CONTENT_SCRIPT_FILE)
}
