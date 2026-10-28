import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

describe('per-job path classification', () => {
  it('keeps the client-only unit suite out of real Codex binary checks', () => {
    const unit = 'src/main/codex/codex-app-server-client.test.ts'
    const expected = {
      should_run: true,
      static_analysis: true,
      typecheck: true,
      git_compatibility: false,
      codex_index_heal_contract: false,
      xterm_patch_sync: false,
      shell_contracts: false,
      test: true,
      orcad_browser: false,
      mobile_web_app: false,
      'cross-version-wire': false,
      managed_hook_node18: false,
      package: false,
      package_windows: false
    }
    expect(classifyPrJobs([unit])).toMatchObject(expected)
    expect(
      classifyPrJobs([
        unit,
        'config/scripts/process-host-build-dist.test.mjs',
        'src/main/ai-vault/session-parse-cache-persistence.test.ts',
        'src/shared/worktree/id.test.ts'
      ])
    ).toMatchObject(expected)
    for (const file of [
      'src/main/codex/codex-app-server-client.ts',
      'src/main/codex/codex-app-server-client-other.test.ts',
      'src/main/codex/codex-app-server-client.test-fixture.ts',
      'src/main/codex/codex-index-heal-binary-contract.test.ts',
      'src/main/pty/codex-no-daemon-binary-contract.test.ts',
      'src/main/codex/codex-hook-file-entry-binary-contract.test.ts',
      'src/main/agent-trust-presets.test.ts',
      '.github/workflows/pr.yml'
    ]) {
      expect(classifyPrJobs([unit, file]).codex_index_heal_contract, file).toBe(true)
    }
  })
})
