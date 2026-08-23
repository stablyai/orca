import type { GlobalSettings } from '../../shared/global-settings-types'
import { getCodexSelectionTargetForAccount } from '../codex-accounts/runtime-selection'
import type { CodexPaneAccountRecord } from './codex-pane-account-registry'

type CodexPaneLaunchHomeSettings = Pick<GlobalSettings, 'codexManagedAccounts'>

export type CodexPaneLaunchHomeResolution =
  | { kind: 'attributed'; path: string }
  | { kind: 'unrecorded' }
  | { kind: 'unknown-account'; accountId: string }
  | { kind: 'unnameable-home' }

/**
 * Resolves the CODEX_HOME a live host pane's Codex is ALREADY running under.
 *
 * Why this is not the selected account's home: `CODEX_HOME` is baked into a
 * shell's environment at spawn, and an automatic resume deliberately pins it to
 * the home that OWNS the session rather than to the current selection. Only that
 * home's `sessions` directory can hold the pane's rollout, so anything reading
 * the live pane's transcript must ask which account it launched under — the
 * record read here is the one `resolveCodexPaneLaunchAccount` wrote at spawn.
 *
 * Declines rather than guessing: probing the wrong account's home reports a
 * broken session when the real cause is an account mismatch.
 */
export function resolveCodexPaneLaunchHome(args: {
  record: CodexPaneAccountRecord | null
  settings: CodexPaneLaunchHomeSettings
  systemCodexHomePath: string
  sharedRuntimeCodexHomePath: string
}): CodexPaneLaunchHomeResolution {
  const record = args.record
  if (!record || record.selectionKey !== 'host') {
    return { kind: 'unrecorded' }
  }
  // Pane-local overrides carry the literal CODEX_HOME the launch resolved, so
  // they answer before the route, which only classifies it.
  const overrideHome =
    record.environmentHomeOverride?.codexHome ?? record.shellStartupHomeOverride?.codexHome
  if (overrideHome) {
    return { kind: 'attributed', path: overrideHome }
  }
  if (record.homeRoute === 'real-home') {
    return { kind: 'attributed', path: args.systemCodexHomePath }
  }
  if (record.homeRoute === 'shared-home') {
    return { kind: 'attributed', path: args.sharedRuntimeCodexHomePath }
  }
  if (record.homeRoute !== 'account-home') {
    // `custom-home` recorded a home Orca cannot re-derive; an absent route predates
    // provenance; `wsl-home` cannot belong to a host pane.
    return { kind: 'unnameable-home' }
  }
  if (!record.accountId) {
    return { kind: 'unnameable-home' }
  }
  const account = args.settings.codexManagedAccounts?.find(
    (candidate) =>
      candidate.id === record.accountId &&
      getCodexSelectionTargetForAccount(candidate).runtime === 'host'
  )
  return account
    ? { kind: 'attributed', path: account.managedHomePath }
    : { kind: 'unknown-account', accountId: record.accountId }
}

/** Names the account cause, so a mismatch never reads as a broken session. */
export function describeCodexPaneLaunchHomeFailure(
  resolution: Exclude<CodexPaneLaunchHomeResolution, { kind: 'attributed' }>
): string {
  if (resolution.kind === 'unknown-account') {
    return `This terminal runs Codex under managed account ${resolution.accountId}, which is no longer configured, so its Codex session cannot be located.`
  }
  if (resolution.kind === 'unnameable-home') {
    return 'This terminal runs Codex under a CODEX_HOME Orca cannot identify, so its Codex session cannot be located.'
  }
  return 'Orca has no record of which Codex account this terminal launched under, so its Codex session cannot be located. Start a new Codex chat instead.'
}
