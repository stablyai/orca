import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { collectModuleSpecifiers } from './static-module-specifiers.mjs'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const RELAY_SOURCE = 'src/relay'

// Why: the SSH relay is being retired; only its own tests may reach into it, and this list only shrinks.
const RELAY_TEST_IMPORTERS = [
  'src/main/ai-vault-search/session-search-scope-entry-points.test.ts',
  'src/main/ai-vault/antigravity-index-file-admission.test.ts',
  'src/main/ai-vault/remote-session-large-transcripts.test.ts',
  'src/main/git/git-network-safety-real-git.test.ts',
  'src/main/git/source-control/blob-absence-real-git.test.ts',
  'src/main/git/source-control/bulk-pathspec-stdin.test.ts',
  'src/main/git/source-control/staging-discard-index-safety.test.ts',
  'src/main/git/status-branch-compare-real-ref.test.ts',
  'src/main/git/status-branch-line-total-relay-parity.test.ts',
  'src/main/git/status-conflict-overlap.bench.test.ts',
  'src/main/git/worktree-rebase-update-refs-real-git.test.ts',
  'src/main/git/worktree-safety-real-git.test.ts',
  'src/main/ipc/filesystem-quick-open-options.integration.test.ts',
  'src/main/ipc/worktree-push-target-cleanup.test.ts',
  'src/main/ipc/worktree-push-target-reconciliation.test.ts',
  'src/main/ipc/worktrees-ssh-fork-push-target-remote.test.ts',
  'src/main/plugins/plugin-host-conformance.test.ts',
  'src/main/providers/ssh-review-draft-context.test.ts',
  'src/main/runtime/runtime-file-path-existence.test.ts',
  'src/main/runtime/runtime-repository-ref-queries.test.ts',
  'src/main/runtime/tui-idle-name-only-real-pty.integration.test.ts',
  'src/main/shell-wrapper-generated-file-snapshot.test.ts',
  'src/main/zsh-scoped-histfile.live-shell.test.ts',
  'src/main/zsh-wrapper-version-mismatch.live-shell.test.ts',
  'tests/tools/omp-relay-close-lifecycle.test.mjs'
]

function importsRelay(file, contents) {
  // Why: parsing every source file overruns the test timeout on a loaded runner.
  if (!contents.includes('relay')) {
    return false
  }
  return collectModuleSpecifiers(file, contents).some((specifier) => {
    if (!specifier.startsWith('.')) {
      return false
    }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    return target === RELAY_SOURCE || target.startsWith(`${RELAY_SOURCE}/`)
  })
}

it('keeps everything outside the SSH relay from importing it', () => {
  const importers = globSync(
    ['src', 'config', 'tests', 'mobile/src', 'mobile/app', 'mobile/scripts'].map(
      (directory) => `${directory}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}`
    ),
    {
      cwd: ROOT,
      exclude: [`${RELAY_SOURCE}/**`, '**/node_modules/**', '**/dist/**', '**/out/**']
    }
  )
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => importsRelay(file, readFileSync(path.join(ROOT, file), 'utf8')))
    .sort()

  expect(importers.filter((file) => !isTestOnlySourcePath(file))).toEqual([])
  expect(importers).toEqual(RELAY_TEST_IMPORTERS)
})
