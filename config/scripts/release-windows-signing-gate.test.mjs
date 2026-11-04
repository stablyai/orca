import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { describe, expect, it } from 'vitest'

describe('Windows release signing waits for macOS success', () => {
  it('runs the verifier CLI from paths requiring URL encoding, as Windows paths do', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca signing gate # % ')))
    const script = join(directory, 'mac verifier.mjs')
    writeFileSync(script, readFileSync('config/scripts/run-release-mac-build-workflow.mjs'))
    try {
      const result = await runProcess({
        program: process.execPath,
        args: [script, 'wait'],
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          RELEASE_MAC_BUILD_REF: 'main',
          GITHUB_REPOSITORY: 'stablyai/orca',
          GITHUB_RUN_ID: '777',
          GITHUB_TOKEN: 'test-token',
          RELEASE_MAC_BUILD_TAG: 'v1.2.3',
          RELEASE_MAC_BUILD_RUN_ID: ''
        }
      })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('RELEASE_MAC_BUILD_RUN_ID is required')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
