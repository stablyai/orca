import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ORCAD_RIPGREP_ARTIFACTS,
  orcadArtifactFilenames
} from '../../src/shared/orcad-artifacts.ts'
import { computeOrcadFullVersion } from './orcad-artifact-version.mjs'

describe('standalone runtime version', () => {
  it('changes when a shipped search binary changes and rejects a missing binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-version-'))
    try {
      for (const filename of orcadArtifactFilenames()) {
        const path = join(dir, filename)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, filename)
      }
      const before = computeOrcadFullVersion(dir)
      const binary = join(dir, ORCAD_RIPGREP_ARTIFACTS[0])
      writeFileSync(binary, 'updated binary')
      expect(computeOrcadFullVersion(dir)).not.toBe(before)
      rmSync(binary)
      expect(() => computeOrcadFullVersion(dir)).toThrow(ORCAD_RIPGREP_ARTIFACTS[0])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
