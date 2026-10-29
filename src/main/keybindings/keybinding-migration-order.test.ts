import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FilesystemHostReadAuthority } from '../filesystem-host/filesystem-host-read-authority'
import {
  configureFilesystemHostReadAuthority,
  setFilesystemHostReadClientForTests
} from '../filesystem-host/filesystem-host-read-client'
import { executeFilesystemHostOperation } from '../filesystem-host/filesystem-host-operation'
import { KeybindingService } from './keybinding-service'
import { getUserKeybindingsPath, readKeybindingFile } from './keybinding-file'

const roots: string[] = []
afterEach(() => {
  setFilesystemHostReadClientForTests(null)
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
it.each(['ensure', 'mutation'] as const)(
  'serializes %s after delayed migration and retries unavailable preparation without creating a file',
  async (change) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-migration-order-'))
    roots.push(root)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let failed = true
    const dispatch = vi.fn(async (input) => {
      await gate
      if (failed) {
        throw new Error('unavailable')
      }
      return executeFilesystemHostOperation(input.operation)
    })
    const authority = new FilesystemHostReadAuthority({
      entryPath: 'unused',
      supervisor: {
        dispatch,
        publishFailureDomain: () => {},
        removeFailureDomain: () => {},
        dispose: async () => {}
      }
    })
    configureFilesystemHostReadAuthority(authority)
    const service = new KeybindingService({
      homePath: root,
      platform: 'darwin',
      getLegacyOverrides: () => ({ 'tab.nextAllTypes': ['Mod+K'] })
    })
    const initial = service.reload().catch(() => {})
    const mutation =
      change === 'ensure'
        ? service.ensureFile()
        : service.setActionBindings('tab.previousAllTypes', ['Mod+J'])
    const rejected = expect(mutation).rejects.toThrow()
    await Promise.resolve()
    expect(existsSync(getUserKeybindingsPath(root))).toBe(false)
    release()
    await initial
    await rejected
    expect(existsSync(getUserKeybindingsPath(root))).toBe(false)
    failed = false
    await (change === 'ensure'
      ? service.ensureFile()
      : service.setActionBindings('tab.previousAllTypes', ['Mod+J']))
    const snapshot = readKeybindingFile(getUserKeybindingsPath(root), 'darwin')
    expect(snapshot.overrides['tab.nextAllTypes']).toEqual(['Mod+K'])
    if (change === 'mutation') {
      expect(snapshot.overrides['tab.previousAllTypes']).toEqual(['Mod+J'])
    }
    await authority.dispose()
  }
)
