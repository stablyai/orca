import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BROWSER_EXTENSION_CONTENT_SCRIPT_FILE,
  BROWSER_EXTENSION_WORKER_SHIM_FILE
} from '../../../shared/browser-extension-worker-api'

const scripts = new Map<string, string>()

/** The build emits these beside the main bundle; this module can sit one level down in chunks/. */
function readBundledScript(fileName: string): string {
  let script = scripts.get(fileName)
  if (script === undefined) {
    const path = [join(__dirname, fileName), join(__dirname, '..', fileName)].find((candidate) =>
      existsSync(candidate)
    )
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
