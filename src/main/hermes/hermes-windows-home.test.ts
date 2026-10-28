import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HermesHookService } from './hook-service'

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('Hermes home on Windows', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    if (realPlatform) {
      Object.defineProperty(process, 'platform', realPlatform)
    }
  })

  it('installs and reports hook status under %LOCALAPPDATA%\\hermes (#24966)', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-win-'))
    try {
      const hermesHome = join(root, 'Local', 'hermes')
      mkdirSync(hermesHome, { recursive: true })
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      vi.stubEnv('LOCALAPPDATA', join(root, 'Local'))
      vi.stubEnv('HERMES_HOME', '')

      expect(new HermesHookService().install().state).toBe('installed')
      expect(new HermesHookService().getStatus()).toMatchObject({
        state: 'installed',
        configPath: join(hermesHome, 'config.yaml'),
        managedHooksPresent: true
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
