import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './config-toml-trust'
import { getExplicitHomeCodexHookSourcePath as getCodexExplicitHomeHookSourcePath } from '../identity/codex-trust-identity'

import {
  createTrustConfigFixture,
  removeTrustConfigFixture
} from './config-toml-trust-test-fixtures'

let tmpDir: string

beforeEach(() => {
  tmpDir = createTrustConfigFixture().tmpDir
})

afterEach(() => {
  removeTrustConfigFixture(tmpDir)
})

describe('computeTrustKey', () => {
  it.skipIf(process.platform === 'win32')(
    'resolves an explicit home parent while preserving its hooks.json leaf symlink',
    () => {
      const logicalHome = join(tmpDir, 'logical-home')
      const targetHome = join(tmpDir, 'target-home')
      const targetHooks = join(tmpDir, 'target-hooks.json')
      mkdirSync(targetHome)
      writeFileSync(targetHooks, '{"hooks":{}}\n', 'utf-8')
      symlinkSync(targetHome, logicalHome)
      symlinkSync(targetHooks, join(targetHome, 'hooks.json'))

      expect(getCodexExplicitHomeHookSourcePath(join(logicalHome, 'hooks.json'))).toBe(
        join(realpathSync.native(targetHome), 'hooks.json')
      )
    }
  )
})
