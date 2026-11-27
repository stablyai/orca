import { describe, expect, it } from 'vitest'
import {
  buildBrowserExtensionWorkerShimInjection,
  withBrowserExtensionModuleShimImport
} from './browser-extension-worker-shim-injection'

const LOAD = 'import "/orca-extension-api.js";'

describe('module worker shim import', () => {
  it.each([
    ['plain code', 'export {}', `${LOAD}export {}`],
    ['a BOM', '\uFEFFexport {}', `\uFEFF${LOAD}export {}`],
    ['a hashbang', '#!/usr/bin/env node\nexport {}', `#!/usr/bin/env node\n${LOAD}export {}`],
    ['a CRLF hashbang', '#!node\r\nexport {}', `#!node\r\n${LOAD}export {}`],
    ['a CR hashbang', '#!node\rexport {}', `#!node\r${LOAD}export {}`],
    ['a lone hashbang', '#!node', `#!node\n${LOAD}`]
  ])('puts the import first in a worker with %s, once', (_shape, source, expected) => {
    const injected = withBrowserExtensionModuleShimImport(Buffer.from(source))
    expect(injected?.toString('utf8')).toBe(expected)
    // Store folders are prepared in place on every run.
    expect(withBrowserExtensionModuleShimImport(injected ?? Buffer.from(''))).toBeNull()
  })
})

describe('background worker path', () => {
  const manifestWithWorker = (path: string) => ({
    manifest_version: 3,
    background: { service_worker: path }
  })

  it('accepts a child folder whose name starts with two dots', () => {
    expect(
      buildBrowserExtensionWorkerShimInjection(manifestWithWorker('..bg/sw.js'))?.workerPath
    ).toBe('..bg/sw.js')
  })

  it('refuses a worker outside the extension folder', () => {
    expect(() => buildBrowserExtensionWorkerShimInjection(manifestWithWorker('../sw.js'))).toThrow(
      'must be inside the extension folder'
    )
  })
})
