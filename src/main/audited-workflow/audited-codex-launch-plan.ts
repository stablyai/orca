// Builds the argv for a read-only Codex plan audit. PURE — no I/O, no spawn —
// so the safety contract has exactly one definition and is trivially testable.
//
// WHY `-c approval_policy="never"` IS MANDATORY, NOT HARDENING.
// `--sandbox read-only` ALONE IS NOT ENFORCING. Verified empirically against
// codex-cli 0.145.0: with `--sandbox read-only` and the default
// `approval: on-request`, Codex escalated a write to an approval request, which
// non-interactive `exec` auto-granted, and the write SUCCEEDED — a file was
// created on disk. Adding `-c approval_policy="never"` makes the sandbox real:
// the same write is refused by the OS ("Access to the path ... is denied"), and
// an adversarial probe of a cwd write, a `../` escape, and `git init && git
// commit` produced zero files and no .git.
//
// WHY `--ignore-user-config` IS MANDATORY.
// Without it a user's ~/.codex/config.toml can set approval_policy back to
// on-request (or widen the sandbox), silently restoring exactly the write
// capability the flag above exists to remove.
//
// WHY `--skip-git-repo-check` IS DELIBERATELY ABSENT.
// The audited worktree has already cleared verified-worktree admission, so
// retaining Codex's own Git-repository check is strictly stricter. It is listed
// as FORBIDDEN so nobody "fixes" a future failure by adding it.
//
// This is still not containment: a read-only sandbox bounds what the process may
// do, but the authoritative Git boundary remains post-run drift detection in
// audited-worktree-drift-verifier.ts, which is indifferent to how a mutation was
// attempted.
import type { LaunchPlanReasonCode } from '../../shared/audited-plan-artifact-types'
import {
  resolveRegistryEntry,
  type AuditedCodexProviderDefinition
} from './audited-codex-provider-registry'
import {
  ALLOWED_CONFIG_KEYS,
  ALLOWED_PROVIDER_FIELDS,
  collectConfigKeysMatching,
  collectConfigOverrides,
  findProviderOverrideViolation
} from './audited-codex-provider-argv-validation'

/**
 * The registry's own base URL for a provider. Comparing the passed entry against
 * this catches a hand-built or mutated definition before it can reach argv —
 * exact equality, not a URL-shape check, because "is it https" proves transport
 * and not trust.
 */
function resolveRegistryEntryBaseUrl(provider: AuditedCodexProviderDefinition): string | null {
  return resolveRegistryEntry(provider.settingsId)?.baseUrl ?? null
}

// Fixed in main. NEVER renderer-selectable — the renderer supplies only taskId.
export const DEFAULT_PLAN_AUDIT_MODEL = 'gpt-5-codex'

export const CODEX_PLAN_AUDIT_TIMEOUT_MS = 15 * 60 * 1000

// The sandbox mode this feature is allowed to run under. Anything else is a
// construction failure, not a warning.
export const REQUIRED_SANDBOX_MODE = 'read-only'
export const REQUIRED_APPROVAL_POLICY_ARG = 'approval_policy="never"'

// Every flag that must be present for the launch to be considered safe. Asserted
// positively so a refactor that drops one fails loudly rather than degrading.
export const REQUIRED_CODEX_FLAGS: readonly string[] = [
  'exec',
  '--sandbox',
  '-c',
  '--ephemeral',
  '--ignore-user-config',
  '--color',
  '-o'
]

// Flags that must NEVER appear. The first two disable the very protections this
// module exists to guarantee; --add-dir would widen the writable set;
// --skip-git-repo-check would relax an admission check we intentionally keep.
export const FORBIDDEN_CODEX_FLAGS: readonly string[] = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--full-auto',
  '--yolo',
  '--add-dir',
  '--skip-git-repo-check'
]

export type BuildCodexPlanAuditPlanArgs = {
  model: string
  /** The audited worktree. Becomes Codex's working root via --cd. */
  worktreePath: string
  /** Main-derived from userData + the canonical run id. Never renderer-supplied. */
  lastMessagePath: string
  /**
   * A RESOLVED REGISTRY ENTRY, never raw settings. The type makes the security
   * property structural: there is no code path from a settings string to a URL,
   * because this function cannot accept one. Absent ⇒ built-in default provider.
   */
  provider?: AuditedCodexProviderDefinition
}

export type CodexPlanAuditPlan =
  | { ok: true; argv: string[] }
  | { ok: false; reasonCode: LaunchPlanReasonCode }

/**
 * Builds the argv, or REFUSES.
 *
 * Returning a failure rather than a weaker argv is the point: every failure mode
 * here (a missing approval override, an enabled user config, a widened sandbox)
 * silently restores write capability, so "build something that still runs" would
 * be strictly worse than not launching at all.
 */
export function buildCodexPlanAuditPlan(args: BuildCodexPlanAuditPlanArgs): CodexPlanAuditPlan {
  if (!isNonEmpty(args.model)) {
    return { ok: false, reasonCode: 'required_flag_missing' }
  }
  if (!isNonEmpty(args.worktreePath) || !isNonEmpty(args.lastMessagePath)) {
    return { ok: false, reasonCode: 'invalid_launch_path' }
  }

  // Provider overrides reconstruct the minimum provider definition explicitly,
  // because --ignore-user-config (correctly) discards the user's own. Every
  // value comes from the resolved REGISTRY ENTRY or a code constant — never from
  // settings, and never from the renderer.
  const providerArgs: string[] = []
  if (args.provider) {
    if (args.provider.baseUrl !== resolveRegistryEntryBaseUrl(args.provider)) {
      return { ok: false, reasonCode: 'provider_endpoint_not_allowed' }
    }
    const id = args.provider.codexProviderId
    providerArgs.push(
      '-c',
      `model_provider="${id}"`,
      '-c',
      `model_providers.${id}.base_url="${args.provider.baseUrl}"`,
      '-c',
      `model_providers.${id}.wire_api="${args.provider.wireApi}"`,
      '-c',
      `model_providers.${id}.env_key="${args.provider.envKey}"`
      // requires_openai_auth is DELIBERATELY ABSENT: with it set and no env_key,
      // Codex does not require the injected variable (probe C), so Orca could not
      // rely on its key being the credential source.
    )
  }

  const argv = [
    'exec',
    '--sandbox',
    REQUIRED_SANDBOX_MODE,
    // Without this the sandbox degrades to auto-granted approvals. See header.
    '-c',
    REQUIRED_APPROVAL_POLICY_ARG,
    ...providerArgs,
    '--model',
    args.model,
    '--cd',
    args.worktreePath,
    '--ephemeral',
    '--ignore-user-config',
    '--color',
    'never',
    '-o',
    args.lastMessagePath,
    // Prompt on stdin: keeps it out of process listings and clear of Windows
    // argv length limits, matching audited-claude-process.ts.
    '-'
  ]

  // Validate what we just built rather than trusting the literal above. This is
  // what makes the guarantee survive a future edit to the array.
  const violation = findLaunchPlanViolation(argv)
  if (violation) {
    return { ok: false, reasonCode: violation }
  }

  return { ok: true, argv }
}

/**
 * Audits a built argv against the full safety contract. Exported so the
 * adversarial test can drive it directly with hand-written argvs, and so the
 * process layer can re-assert immediately before spawning.
 */
export function findLaunchPlanViolation(argv: readonly string[]): LaunchPlanReasonCode | null {
  for (const flag of FORBIDDEN_CODEX_FLAGS) {
    if (argv.some((entry) => entry === flag || entry.startsWith(`${flag}=`))) {
      return 'forbidden_flag_present'
    }
  }

  for (const flag of REQUIRED_CODEX_FLAGS) {
    if (!argv.includes(flag)) {
      return 'required_flag_missing'
    }
  }

  // EVERY sandbox declaration, in every spelling. Checking only the first
  // occurrence was a real hole: an APPENDED `--sandbox workspace-write` would
  // pass a first-occurrence check while the CLI applies the last value.
  const sandboxDeclarations = collectSandboxDeclarations(argv)
  if (sandboxDeclarations.length !== 1) {
    // Zero is a missing flag; two or more is ambiguous and never intended.
    return sandboxDeclarations.length === 0 ? 'required_flag_missing' : 'unsafe_sandbox_mode'
  }
  if (sandboxDeclarations[0] !== REQUIRED_SANDBOX_MODE) {
    return 'unsafe_sandbox_mode'
  }

  // Same strictness for the approval policy: exactly one declaration, and it
  // must be the enforcing one. A duplicate — even a duplicate of the SAME value
  // — is rejected, because a second override is evidence the argv was assembled
  // by something other than buildCodexPlanAuditPlan.
  const approvalOverrides = collectConfigOverrides(argv, 'approval_policy')
  if (approvalOverrides.length === 0) {
    return 'required_flag_missing'
  }
  if (approvalOverrides.length > 1) {
    return 'unsafe_approval_policy'
  }
  if (approvalOverrides[0] !== REQUIRED_APPROVAL_POLICY_ARG) {
    return 'unsafe_approval_policy'
  }

  // A -c sandbox override would silently outrank the --sandbox flag above.
  if (collectConfigOverrides(argv, 'sandbox_mode').length > 0) {
    return 'unsafe_sandbox_mode'
  }
  if (collectConfigOverrides(argv, 'sandbox_permissions').length > 0) {
    return 'unsafe_sandbox_mode'
  }

  // EXHAUSTIVE `-c` ALLOW-LIST. Anything outside the permitted key set is
  // refused, which is what makes provider injection safe: a malformed or
  // hostile override cannot reach sandbox, approval, or any other setting.
  // Checked before the provider rules so an unknown key never reaches them.
  for (const key of collectConfigKeysMatching(argv, () => true)) {
    const permitted =
      ALLOWED_CONFIG_KEYS.includes(key) ||
      (key.startsWith('model_providers.') &&
        ALLOWED_PROVIDER_FIELDS.some((field) => key.endsWith(`.${field}`))) ||
      // requires_openai_auth is recognized here only so the provider check can
      // report its dedicated, more specific code rather than a generic refusal.
      key.endsWith('.requires_openai_auth')
    if (!permitted) {
      return 'forbidden_flag_present'
    }
  }

  const providerViolation = findProviderOverrideViolation(argv)
  if (providerViolation) {
    return providerViolation
  }

  if (!argv.includes('--ignore-user-config')) {
    return 'user_config_not_ignored'
  }

  if (argv.at(-1) !== '-') {
    return 'required_flag_missing'
  }

  return null
}

// Every spelling the CLI accepts for the sandbox option. `-s` is the documented
// short form; omitting it would leave an obvious bypass.
const SANDBOX_FLAGS: readonly string[] = ['--sandbox', '-s']

/**
 * Returns one entry per sandbox DECLARATION, in argv order.
 *
 * A declaration with no value yields an empty string rather than being skipped,
 * so `['--sandbox']` at the end of argv is counted and then rejected as an
 * invalid value — silently ignoring it would let a malformed argv through.
 */
function collectSandboxDeclarations(argv: readonly string[]): string[] {
  const declarations: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]
    if (typeof entry !== 'string') {
      continue
    }
    // `--sandbox=value` / `-s=value`
    const inlineFlag = SANDBOX_FLAGS.find((flag) => entry.startsWith(`${flag}=`))
    if (inlineFlag) {
      declarations.push(entry.slice(inlineFlag.length + 1))
      continue
    }
    // `--sandbox value` / `-s value`
    if (SANDBOX_FLAGS.includes(entry)) {
      declarations.push(argv[index + 1] ?? '')
      // Skip the consumed value so a value that happens to look like a flag is
      // not itself re-parsed as a declaration.
      index += 1
    }
  }
  return declarations
}

function isNonEmpty(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0
}
