import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

describe('Codex index-heal contract PR gate', () => {
  const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
  const job = workflow.jobs.codex_index_heal_contract

  it('installs and verifies against one pinned Codex version', () => {
    const install = job.steps.find((step) => step.name === 'Install pinned Codex CLI')
    const verify = job.steps.find((step) => step.name === 'Verify Codex index-heal contract')

    // Why one source: the install and the runtime version assertion drifting apart is
    // the failure that would leave this job verifying a Codex nobody declared.
    expect(job.env.CODEX_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(install.run).toContain('"@openai/codex@$CODEX_CLI_VERSION"')
    expect(verify.env.ORCA_CODEX_CONTRACT_VERSION).toBe('${{ env.CODEX_CLI_VERSION }}')

    // The install prefix and the binary the test is pointed at must be the same tree.
    expect(install.run).toContain('--prefix "$RUNNER_TEMP/codex-cli"')
    expect(verify.run).toContain(
      'ORCA_CODEX_CONTRACT_BINARY="$RUNNER_TEMP/codex-cli/node_modules/.bin/codex"'
    )
    expect(verify.run).toContain('src/main/codex/codex-index-heal-binary-contract.test.ts')
  })

  it('fails rather than skipping when the Codex binary is missing', () => {
    const verify = job.steps.find((step) => step.name === 'Verify Codex index-heal contract')

    // Why asserted: the contract skips itself without a binary, so a failed install
    // would otherwise turn this job into a green no-op that verifies nothing.
    expect(verify.env.ORCA_CODEX_CONTRACT_REQUIRED).toBe('1')
    expect(job.steps.find((step) => step.name === 'Install pinned Codex CLI').run).toContain(
      'set -euo pipefail'
    )
  })
})
