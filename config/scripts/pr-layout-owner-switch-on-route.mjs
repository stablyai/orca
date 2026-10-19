// Paths whose change runs the advisory `layout_owner_switch_on` job in pr.yml.
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { MANAGED_SSH_E2E_SPEC_PREFIX } from './ci-e2e-job-selection.mjs'
import { LAYOUT_ORACLE_E2E_SPECS } from './pr-layout-oracle-route.mjs'

/** The oracle, its positive control, and the layout-owner acceptance specs. */
export const LAYOUT_OWNER_SWITCH_ON_E2E_SPECS = [
  ...LAYOUT_ORACLE_E2E_SPECS,
  // Positive control: its direct store write must leave at least one divergence report.
  'tests/e2e/cli-file-open-position.spec.ts',
  'tests/e2e/relaunch-first-terminal.spec.ts',
  'tests/e2e/relaunch-sleeping-agents-resume-on-view.spec.ts',
  'tests/e2e/terminal-cold-activation-deferral.spec.ts',
  'tests/e2e/cli-first-worktree-single-terminal.spec.ts',
  'tests/e2e/unopened-workspace-agent-single-resume.spec.ts',
  'tests/e2e/terminal-pane-close-layout-consistency.spec.ts',
  // Saves that drop a terminal's tab-bar entry. Not diff-word-wrap.spec.ts: its file-diff case
  // fails with the switch off too (main's scheduled e2e run 39148564778, shard 2).
  'tests/e2e/golden-file-open-edit-save.spec.ts',
  'tests/e2e/golden-source-control-open-diff.spec.ts',
  'tests/e2e/paired-cli-terminal-graph-sync-tab-retention.spec.ts',
  // Saves whose tab order differs from main's while a frame is held.
  'tests/e2e/floating-workspace-pane-height.spec.ts',
  'tests/e2e/editor-model-host-isolation.spec.ts',
  'tests/e2e/editor-tab-selection-restore.spec.ts',
  'tests/e2e/finished-agent-ghost-resume.spec.ts',
  'tests/e2e/live-background-terminal-mount-authority.spec.ts',
  'tests/e2e/workspace-back-forward-navigation.spec.ts',
  'tests/e2e/worktree-lineage-toggle-shortcut.spec.ts',
  'tests/e2e/local-cli-terminal-retention.spec.ts',
  'tests/e2e/default-tabs-mark-crash-relaunch.spec.ts',
  'tests/e2e/terminal-cli-split-closed-before-mount.spec.ts',
  'tests/e2e/layout-stream-loss-reopen.spec.ts',
  // Every managed-SSH spec, in e2e.yml's Docker lane; its orcad template stays switch-off.
  MANAGED_SSH_E2E_SPEC_PREFIX
]

const LAYOUT_OWNER_SWITCH_ON_PREFIXES = [
  'src/shared/workspace-layout',
  'src/shared/layout-owner-switch.ts',
  'src/main/persistence/',
  'src/main/runtime/',
  'src/renderer/src/store/',
  'tests/e2e/',
  // The job itself.
  '.github/workflows/pr.yml',
  '.github/workflows/e2e.yml',
  'config/scripts/pr-layout-owner-switch-on-route.mjs',
  'config/scripts/layout-save-divergence-summary.mjs'
]

export function isLayoutOwnerSwitchOnSource(file) {
  return LAYOUT_OWNER_SWITCH_ON_PREFIXES.some((prefix) => file.startsWith(prefix))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
  }
  const changedPaths = input.split(/\r?\n/).filter(Boolean)
  process.stdout.write(`${changedPaths.some(isLayoutOwnerSwitchOnSource)}\n`)
}
