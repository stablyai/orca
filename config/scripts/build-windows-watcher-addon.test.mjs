import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { stageWindowsWatcherSource } from './build-windows-watcher-addon.mjs'

it.each([false, true])(
  'stages the readiness patch without modifying installed sources (sanitizer: %s)',
  (sanitize) => {
    const root = resolve(import.meta.dirname, '../..')
    const source = join(root, 'node_modules/@parcel/watcher/src/windows/WindowsBackend.cc')
    const before = readFileSync(source, 'utf8')
    const staging = mkdtempSync(join(root, '.watcher-build-test-'))
    try {
      stageWindowsWatcherSource(staging, { sanitize })
      const backend = readFileSync(join(staging, 'src/Backend.cc'), 'utf8')
      expect(backend.indexOf('lock.unlock();')).toBeLessThan(
        backend.indexOf('state->waitUntilReady();')
      )
      expect(backend).toContain('state->waitUntilReady();')
      const windows = readFileSync(join(staging, 'src/windows/WindowsBackend.cc'), 'utf8')
      expect(windows).toContain('mReady.set_exception(std::current_exception())')
      expect(windows).not.toContain('Sleep(250)')
      expect(windows).not.toContain('injected-failure')
      expect(windows).toContain('CancelIoEx(mDirectoryHandle, nullptr)')
      const binding = readFileSync(join(staging, 'binding.gyp'), 'utf8')
      expect(binding.includes('/fsanitize=address')).toBe(sanitize)
      expect(binding.includes('/INCREMENTAL:NO')).toBe(sanitize)
      expect(existsSync(join(staging, 'deps/node-addon-api/napi.h'))).toBe(true)
      expect(readFileSync(source, 'utf8')).toBe(before)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
)
