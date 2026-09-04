import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  classifyPrJobs,
  isDocsOnlyPath,
  PR_CHECK_JOBS,
  shouldRunPrChecks
} from './pr-code-change-scope.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const prWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))

const expensiveJobs = [
  'static_analysis',
  'typecheck',
  'git_compatibility',
  'codex_index_heal_contract',
  'xterm_patch_sync',
  'shell_contracts',
  'test',
  'orcad_browser',
  'cross-version-wire',
  'managed_hook_node18',
  'package',
  'package_windows'
]

const ALWAYS_ON = ['static_analysis', 'typecheck', 'test']

function expectedJobs(overrides, { alwaysOn = true } = {}) {
  return Object.fromEntries(
    PR_CHECK_JOBS.map((job) => [
      job,
      (alwaysOn && ALWAYS_ON.includes(job)) || Boolean(overrides[job])
    ])
  )
}

function expectClassification(files, overrides) {
  const result = classifyPrJobs(files)
  const shouldRun = shouldRunPrChecks(files)
  expect(result.should_run).toBe(shouldRun)
  expect(result).toMatchObject({
    should_run: shouldRun,
    ...expectedJobs(overrides, { alwaysOn: shouldRun })
  })
}

describe('docs-only path classification', () => {
  it('treats the WeChat README PR files as docs-only', () => {
    expect(
      shouldRunPrChecks([
        'README.md',
        'docs/assets/wechat-qr-group8.jpg',
        'docs/readme/README.zh-CN.md'
      ])
    ).toBe(false)
  })

  it('skips root instruction files and GitHub markdown templates', () => {
    expect(isDocsOnlyPath('AGENTS.md')).toBe(true)
    expect(isDocsOnlyPath('CLAUDE.md')).toBe(true)
    expect(isDocsOnlyPath('LICENSE')).toBe(true)
    expect(isDocsOnlyPath('.github/CONTRIBUTING.md')).toBe(true)
    expect(isDocsOnlyPath('.github/pull_request_template.md')).toBe(true)
    expect(isDocsOnlyPath('.github/ISSUE_TEMPLATE/bug_report.yml')).toBe(true)
    expect(isDocsOnlyPath('.github/CODEOWNERS')).toBe(true)
  })

  it('still runs PR Checks for product markdown and CI', () => {
    expect(isDocsOnlyPath('skills/computer-use/SKILL.md')).toBe(false)
    expect(isDocsOnlyPath('skill-guides/orca-cli.md')).toBe(false)
    expect(isDocsOnlyPath('.github/workflows/pr.yml')).toBe(false)
    expect(isDocsOnlyPath('src/main/index.ts')).toBe(false)
    expect(isDocsOnlyPath('config/scripts/pr-code-change-scope.mjs')).toBe(false)
    expect(shouldRunPrChecks(['README.md', 'src/main/index.ts'])).toBe(true)
  })

  it('runs PR Checks when the diff is empty rather than skipping by accident', () => {
    expect(shouldRunPrChecks([])).toBe(true)
  })

  it('does not start desktop PR Checks for mobile-only diffs', () => {
    expect(shouldRunPrChecks(['mobile/src/App.tsx', 'mobile/package.json'])).toBe(false)
  })

  it('does not start desktop PR Checks for cloud-only diffs', () => {
    expect(
      shouldRunPrChecks([
        'cloud/apps/relay/src/index.ts',
        'cloud/package.json',
        'cloud/.gitleaks.toml',
        '.github/workflows/cloud-verify.yml'
      ])
    ).toBe(false)
  })
})

describe('per-job path classification', () => {
  it('runs every expensive job on an empty diff rather than skipping by accident', () => {
    const result = classifyPrJobs([])
    expect(result.should_run).toBe(true)
    for (const job of PR_CHECK_JOBS) {
      expect(result[job], job).toBe(true)
    }
  })

  it('skips every expensive job for docs-only diffs', () => {
    expectClassification(['README.md', 'docs/readme/README.zh-CN.md'], {})
  })

  it('runs packaging and always-on jobs for product source, not git/xterm/shell lanes', () => {
    expectClassification(['src/renderer/src/components/tab-bar/TabBar.tsx'], {
      package: true,
      package_windows: true
    })
  })

  it('runs Git compatibility only when git capability inputs change', () => {
    expectClassification(['src/shared/git-capability-cache.ts'], {
      git_compatibility: true,
      package: true,
      package_windows: true
    })
    expectClassification(['src/shared/git-binary-compatibility.test.ts'], {
      git_compatibility: true
    })
  })

  it('runs the Codex index-heal contract only when the heal or its transport changes', () => {
    expectClassification(['src/main/codex/codex-session-index-heal.ts'], {
      codex_index_heal_contract: true,
      package: true,
      package_windows: true
    })
    expectClassification(['src/main/sqlite/sync-database.ts'], {
      codex_index_heal_contract: true,
      package: true,
      package_windows: true
    })
    expectClassification(['src/main/codex/codex-app-server-session.ts'], {
      codex_index_heal_contract: true,
      package: true,
      package_windows: true
    })
    expectClassification(['src/main/codex/codex-index-heal-binary-contract.test.ts'], {
      codex_index_heal_contract: true
    })
    // Keep the real-binary gate live when a transport or launch dependency changes.
    for (const file of [
      'src/main/codex/codex-app-server-capability-signal.ts',
      'src/main/codex/codex-process-exit-deadline.ts',
      'src/main/codex/codex-session-backfill.ts',
      'src/main/codex/codex-session-index-heal-state.ts',
      'src/main/codex-cli/command.ts',
      'src/main/win32-utils.ts',
      'src/shared/node-cli-command-resolution.ts',
      'src/shared/windows-batch-spawn.ts'
    ]) {
      expectClassification([file], {
        codex_index_heal_contract: true,
        package: true,
        package_windows: true
      })
    }
    // A neighbouring Codex module must not drag the real-binary job in.
    expectClassification(['src/main/codex/codex-home-paths.ts'], {
      package: true,
      package_windows: true
    })
  })

  it('runs xterm patch sync only when xterm inputs change', () => {
    expectClassification(['config/patches/xterm-upstream.json'], {
      xterm_patch_sync: true
    })
    expectClassification(['config/patches/@xterm__xterm@6.1.0-beta.287.patch'], {
      xterm_patch_sync: true
    })
  })

  it('runs native package jobs only for the platform that ships the changed native', () => {
    expectClassification(['native/windows-cli-launcher/OrcaCliLauncher.cs'], {
      package_windows: true
    })
    expectClassification(['native/computer-use-linux/runtime.py'], {
      package: true
    })
    expectClassification(['native/computer-use-macos/Package.swift'], {})
  })

  it('runs Linux packaging when an artifact contract changes', () => {
    for (const file of [
      'config/docker/cli-launch-contract/Dockerfile',
      'config/docker/cli-launch-contract/run-cli-case.sh',
      'config/docker/headless-pairing/Dockerfile',
      'config/docker/headless-pairing/run-appimage-case.sh',
      'config/docker/headless-serve-shutdown/Dockerfile',
      'config/scripts/run-linux-cli-launch-contract-docker.mjs',
      'config/scripts/run-headless-linux-pairing-docker.mjs',
      'config/scripts/static-appimage-package-contract.cjs'
    ]) {
      expectClassification([file], { package: true })
    }
  })

  it('runs both package jobs when the shared skills runtime verifier changes', () => {
    expectClassification(['config/scripts/verify-skills-cli-runtime.cjs'], {
      package: true,
      package_windows: true
    })
  })

  it('runs shell contracts when live-shell inputs change', () => {
    expectClassification(['src/main/daemon/shell-ready.ts'], {
      shell_contracts: true,
      package: true,
      package_windows: true
    })
  })

  it('runs shell contracts when wrapper templates or live-shell fixtures change', () => {
    expectClassification(['src/main/shell-templates.ts'], {
      shell_contracts: true,
      package: true,
      package_windows: true
    })
    expectClassification(['src/main/shell-startup-launch-intent-fixtures.ts'], {
      shell_contracts: true,
      package: true,
      package_windows: true
    })
  })

  it('runs orcad browser when Chrome launch, session, or tab modules change', () => {
    for (const file of [
      'src/main/orcad/external-chromium-browser-session.ts',
      'src/main/orcad/external-chromium-command-arguments.ts',
      'src/main/orcad/external-chromium-tab-registry.ts',
      'src/main/orcad/external-chromium-tab-projection.ts'
    ]) {
      expectClassification([file], {
        orcad_browser: true,
        package: true,
        package_windows: true
      })
    }
    expectClassification(['src/main/orcad/orcad-native-preflight.ts'], {
      package: true,
      package_windows: true
    })
  })

  it('runs cross-version wire checks for every working-tree wire module', () => {
    for (const file of [
      'src/shared/protocol-version.ts',
      'src/shared/terminal-stream-protocol.ts',
      'src/shared/agent-session-wire.ts',
      'src/shared/agent-session-mutation-envelope.ts',
      'src/shared/agent-session-journal-item-key.ts',
      'src/shared/agent-session-journal-types.ts',
      'src/main/ai-vault/structured-session-ownership.ts',
      'src/main/native-chat/agent-session-journal/journal-cursor.ts',
      'src/main/native-chat/agent-session-journal/journal-reducer.ts',
      'src/main/native-chat/agent-session-journal/journal-row-schema.ts',
      'src/main/native-chat/agent-session-wire/structured-agent-session-host.ts',
      'src/main/runtime/agent-session-record-store.ts',
      'src/main/runtime/rpc/dispatcher.ts',
      'src/main/runtime/rpc/methods/ai-vault.ts',
      'src/main/runtime/rpc/methods/browser-tab-create-schema.ts',
      'src/main/runtime/rpc/methods/session-tabs.ts',
      'src/main/runtime/rpc/methods/structured-agent-session.ts',
      'src/main/runtime/rpc/methods/structured-agent-session-gate.ts',
      'src/main/runtime/rpc/methods/structured-agent-session-hold.ts',
      'src/main/runtime/rpc/methods/structured-agent-session-schemas.ts',
      'src/main/runtime/rpc/methods/terminal.ts',
      'src/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts'
    ]) {
      expectClassification([file], {
        'cross-version-wire': true,
        package: true,
        package_windows: true
      })
    }
    expectClassification(
      ['tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts'],
      { 'cross-version-wire': true }
    )
  })

  it('runs workflow-self-change and lockfile diffs as force-all', () => {
    const result = classifyPrJobs(['.github/workflows/pr.yml'])
    expect(result.should_run).toBe(true)
    for (const job of PR_CHECK_JOBS) {
      expect(result[job], job).toBe(true)
    }
    expect(classifyPrJobs(['pnpm-lock.yaml']).git_compatibility).toBe(true)
  })

  it('primes native caches only when their immutable inputs change', () => {
    expect(classifyPrJobs([]).native_cache_changed).toBe(true)
    expect(classifyPrJobs(['README.md']).native_cache_changed).toBe(false)
    expect(classifyPrJobs(['src/main/index.ts']).native_cache_changed).toBe(false)
    for (const file of [
      'package.json',
      'pnpm-lock.yaml',
      '.github/actions/install-node-dependencies/action.yml',
      'config/scripts/ensure-native-runtime.mjs',
      'config/scripts/rebuild-native-deps.mjs',
      'config/patches/node-pty@1.1.0.patch'
    ]) {
      expect(classifyPrJobs([file]).native_cache_changed, file).toBe(true)
    }
  })

  // Why: static analysis lints changed mobile files with a type-aware pass, and
  // mobile is a separate pnpm project. Without its node_modules every mobile type
  // resolves to an `error` type and the changed-code gate fails on phantom
  // findings, which is exactly how a react-test-renderer union broke a PR.
  it('installs mobile dependencies exactly when mobile files change', () => {
    expect(classifyPrJobs([]).mobile_dependencies).toBe(true)
    expect(classifyPrJobs(['README.md']).mobile_dependencies).toBe(false)
    expect(classifyPrJobs(['src/main/index.ts']).mobile_dependencies).toBe(false)
    expect(
      classifyPrJobs(['src/main/index.ts', 'mobile/src/session/a.test.ts']).mobile_dependencies
    ).toBe(true)
    // Why false: a mobile-only diff skips every desktop job, so the install step's own
    // job never runs and claiming the install is needed contradicts should_run.
    expect(classifyPrJobs(['mobile/package.json']).mobile_dependencies).toBe(false)
    expect(classifyPrJobs(['mobile/package.json']).should_run).toBe(false)
    expect(classifyPrJobs(['README.md', 'mobile/src/a.ts']).mobile_dependencies).toBe(false)
  })

  it('keeps unit-test-only diffs out of packaging', () => {
    expectClassification(['src/main/git/git-status.test.ts'], {
      git_compatibility: true
    })
  })

  it('emits GitHub output pairs from the shipped CLI', () => {
    const result = spawnSync(process.execPath, ['config/scripts/pr-code-change-scope.mjs'], {
      cwd: projectDir,
      encoding: 'utf8',
      input: 'config/patches/xterm-upstream.json\n'
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('should_run=true\n')
    expect(result.stdout).toContain('xterm_patch_sync=true\n')
    expect(result.stdout).toContain('git_compatibility=false\n')
    expect(result.stdout).toContain('package=false\n')
    expect(result.stdout).toContain('test=true\n')
  })
})

describe('PR Checks skip wiring', () => {
  it('classifies the PR range with a tested script and expands renames', () => {
    const classify = prWorkflow.jobs.code_paths.steps.find(
      (step) => step.name === 'Classify changed paths'
    )
    expect(classify.run).toContain('--diff-filter=ACDMR')
    expect(classify.run).toContain('--no-renames')
    expect(classify.run).toContain('--merge-base "$BASE_SHA" "$HEAD_SHA"')
    expect(classify.run).toContain('node config/scripts/pr-code-change-scope.mjs')
    expect(classify.run).toContain('tee -a "$GITHUB_OUTPUT"')
    for (const jobName of ['should_run', 'native_cache_changed', ...expensiveJobs]) {
      expect(prWorkflow.jobs.code_paths.outputs[jobName], jobName).toBe(
        `\${{ steps.filter.outputs.${jobName} }}`
      )
    }
  })

  it('gives static analysis the mobile types its type-aware pass resolves', () => {
    expect(prWorkflow.jobs.code_paths.outputs.mobile_dependencies).toBe(
      '${{ steps.filter.outputs.mobile_dependencies }}'
    )
    const steps = prWorkflow.jobs.static_analysis.steps
    const install = steps.findIndex((step) => step.name === 'Install mobile dependencies')
    const gate = steps.findIndex((step) => step.name === 'Enforce changed-code quality')
    expect(install).toBeGreaterThan(-1)
    expect(install).toBeLessThan(gate)
    expect(steps[install].if).toBe("needs.code_paths.outputs.mobile_dependencies == 'true'")
    expect(steps[install]['working-directory']).toBe('mobile')
    expect(steps[install].run).toContain('--frozen-lockfile')
  })

  it('keeps the cheap root-directory guard on docs-only PRs', () => {
    expect(prWorkflow.jobs.root_directory_guard.if).toBeUndefined()
    expect(prWorkflow.jobs.root_directory_guard.needs).toBeUndefined()
  })

  it('gates each expensive job on its classifier and cache prerequisite', () => {
    for (const jobName of expensiveJobs.filter((jobName) => jobName !== 'test')) {
      expect(prWorkflow.jobs[jobName].needs, jobName).toEqual(['code_paths'])
      expect(prWorkflow.jobs[jobName].if, jobName).toBe(
        `needs.code_paths.outputs.${jobName} == 'true'`
      )
    }
    expect(prWorkflow.jobs.test.needs).toEqual(['code_paths', 'test_native_cache'])
    expect(prWorkflow.jobs.test.if).toContain("needs.code_paths.outputs.test == 'true'")
    expect(prWorkflow.jobs.test.if).toContain("needs.test_native_cache.result == 'success'")
    expect(prWorkflow.jobs.test.if).toContain("needs.test_native_cache.result == 'skipped'")
    expect(prWorkflow.jobs.test_native_cache.needs).toEqual(['code_paths'])
    expect(prWorkflow.jobs.test_native_cache.if).toBe(
      "needs.code_paths.outputs.native_cache_changed == 'true'"
    )
    expect(prWorkflow.jobs.test_native_cache.strategy).toBeUndefined()
    const primerInstall = prWorkflow.jobs.test_native_cache.steps.find(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )
    expect(primerInstall.with['node-version']).toBe('24')
  })

  it('skips e2e detection on docs-only PRs without dropping the draft gate', () => {
    expect(prWorkflow.jobs['e2e-paths'].needs).toEqual(['code_paths'])
    expect(prWorkflow.jobs['e2e-paths'].if).toBe(
      "github.event.pull_request.draft != true && needs.code_paths.outputs.should_run == 'true'"
    )
  })

  it('lets verify pass skipped jobs the classifier turned off', () => {
    const verifyStep = prWorkflow.jobs.verify.steps.find(
      (step) => step.name === 'Require successful checks'
    )
    expect(prWorkflow.jobs.verify.needs[0]).toBe('code_paths')
    expect(verifyStep.env.SHOULD_RUN).toBe('${{ needs.code_paths.outputs.should_run }}')
    expect(verifyStep.run).toContain('"$ROOT_DIRECTORY_GUARD" != "success"')
    expect(verifyStep.run).toContain('# Require success when the PR has code-relevant changes')
    expect(verifyStep.run).toContain('expected skipped')
    expect(verifyStep.run).toContain('expected success')
    for (const job of prWorkflow.jobs.verify.needs) {
      if (job === 'code_paths' || job === 'root_directory_guard') {
        continue
      }
      const envVar = `${job.replaceAll('-', '_').toUpperCase()}_SHOULD_RUN`
      expect(verifyStep.env[envVar]).toBe(`\${{ needs.code_paths.outputs.${job} }}`)
      expect(verifyStep.run).toContain(`"$${envVar}"`)
    }
  })
})
