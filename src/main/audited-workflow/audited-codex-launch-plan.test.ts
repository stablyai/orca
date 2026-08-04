// Adversarial tests for the Codex read-only launch contract.
//
// These encode an EMPIRICAL finding, not a style preference: against
// codex-cli 0.145.0, `--sandbox read-only` WITHOUT `-c approval_policy="never"`
// escalated a write to an auto-granted approval and the write SUCCEEDED. With
// the override, the same write was refused by the OS. If any assertion here is
// ever relaxed, the sandbox silently stops being a boundary.
import { describe, expect, it } from 'vitest'
import {
  buildCodexPlanAuditPlan,
  findLaunchPlanViolation,
  DEFAULT_PLAN_AUDIT_MODEL,
  FORBIDDEN_CODEX_FLAGS,
  REQUIRED_APPROVAL_POLICY_ARG
} from './audited-codex-launch-plan'

const VALID = {
  model: DEFAULT_PLAN_AUDIT_MODEL,
  worktreePath: '/tmp/audited/wt',
  lastMessagePath: '/tmp/userData/audited-workflow/reviews/rev_1/last-message.txt'
}

function buildArgv(): string[] {
  const plan = buildCodexPlanAuditPlan(VALID)
  if (!plan.ok) {
    throw new Error(`expected a valid plan, got ${plan.reasonCode}`)
  }
  return plan.argv
}

describe('buildCodexPlanAuditPlan', () => {
  it('runs codex exec non-interactively', () => {
    expect(buildArgv()[0]).toBe('exec')
  })

  it('pins the sandbox to read-only', () => {
    const argv = buildArgv()
    expect(argv).toContain('--sandbox')
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only')
  })

  // THE load-bearing assertion. read-only alone is not enforcing.
  it('always passes -c approval_policy="never"', () => {
    const argv = buildArgv()
    expect(argv).toContain('-c')
    expect(argv).toContain(REQUIRED_APPROVAL_POLICY_ARG)
    expect(argv[argv.indexOf('-c') + 1]).toBe('approval_policy="never"')
  })

  it('always ignores user config so it cannot re-enable approvals', () => {
    expect(buildArgv()).toContain('--ignore-user-config')
  })

  it('always runs ephemerally', () => {
    expect(buildArgv()).toContain('--ephemeral')
  })

  it('does NOT pass --skip-git-repo-check', () => {
    // The audited worktree already cleared verified-worktree admission, so
    // keeping Codex's own repo check is strictly stricter.
    expect(buildArgv()).not.toContain('--skip-git-repo-check')
  })

  it('contains no forbidden flag', () => {
    const argv = buildArgv()
    for (const flag of FORBIDDEN_CODEX_FLAGS) {
      expect(argv).not.toContain(flag)
    }
  })

  it('reads the prompt from stdin and never from argv', () => {
    const argv = buildArgv()
    expect(argv.at(-1)).toBe('-')
    expect(argv.some((entry) => entry.includes('You are auditing'))).toBe(false)
  })

  it('uses the main-derived model, worktree cwd, and output path', () => {
    const argv = buildArgv()
    expect(argv[argv.indexOf('--model') + 1]).toBe(DEFAULT_PLAN_AUDIT_MODEL)
    expect(argv[argv.indexOf('--cd') + 1]).toBe(VALID.worktreePath)
    expect(argv[argv.indexOf('-o') + 1]).toBe(VALID.lastMessagePath)
  })

  it('refuses to build without a launch path', () => {
    expect(buildCodexPlanAuditPlan({ ...VALID, lastMessagePath: '' })).toEqual({
      ok: false,
      reasonCode: 'invalid_launch_path'
    })
    expect(buildCodexPlanAuditPlan({ ...VALID, worktreePath: '  ' })).toEqual({
      ok: false,
      reasonCode: 'invalid_launch_path'
    })
  })

  it('refuses to build without a model', () => {
    expect(buildCodexPlanAuditPlan({ ...VALID, model: '' })).toEqual({
      ok: false,
      reasonCode: 'required_flag_missing'
    })
  })
})

describe('findLaunchPlanViolation', () => {
  it('accepts the argv the builder produces', () => {
    expect(findLaunchPlanViolation(buildArgv())).toBeNull()
  })

  it('rejects a widened sandbox rather than downgrading it', () => {
    const argv = buildArgv()
    argv[argv.indexOf('--sandbox') + 1] = 'workspace-write'
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_sandbox_mode')

    const full = buildArgv()
    full[full.indexOf('--sandbox') + 1] = 'danger-full-access'
    expect(findLaunchPlanViolation(full)).toBe('unsafe_sandbox_mode')
  })

  it('rejects a -c sandbox_mode override that would outrank --sandbox', () => {
    const argv = buildArgv()
    argv.splice(-1, 0, '-c', 'sandbox_mode="danger-full-access"')
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_sandbox_mode')
  })

  it('rejects any approval policy other than never', () => {
    const argv = buildArgv()
    argv[argv.indexOf(REQUIRED_APPROVAL_POLICY_ARG)] = 'approval_policy="on-request"'
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_approval_policy')
  })

  it('rejects a missing approval policy', () => {
    const argv = buildArgv().filter((entry) => entry !== REQUIRED_APPROVAL_POLICY_ARG)
    expect(findLaunchPlanViolation(argv)).toBe('required_flag_missing')
  })

  it('rejects argv that would load user config', () => {
    const argv = buildArgv().filter((entry) => entry !== '--ignore-user-config')
    // --ignore-user-config is also in REQUIRED_CODEX_FLAGS, so the required-flag
    // check fires first; either way the plan is refused, never downgraded.
    expect(findLaunchPlanViolation(argv)).not.toBeNull()
  })

  it.each(FORBIDDEN_CODEX_FLAGS)('rejects the forbidden flag %s', (flag) => {
    const argv = buildArgv()
    argv.splice(1, 0, flag)
    expect(findLaunchPlanViolation(argv)).toBe('forbidden_flag_present')
  })

  it('rejects a prompt moved out of stdin into argv', () => {
    const argv = buildArgv()
    argv[argv.length - 1] = 'review this plan' // eslint-disable-line unicorn/prefer-at -- assignment, .at() is read-only
    expect(findLaunchPlanViolation(argv)).toBe('required_flag_missing')
  })

  it.each(['exec', '--ephemeral', '--color', '-o'])('rejects a missing %s', (flag) => {
    const argv = buildArgv().filter((entry) => entry !== flag)
    expect(findLaunchPlanViolation(argv)).not.toBeNull()
  })
})

// These encode the LAST-VALUE-WINS hazard. A first-occurrence check passes an
// argv whose effective sandbox is wide open, because the CLI applies the final
// declaration. Every case below must be refused BEFORE any spawn.
describe('findLaunchPlanViolation — every sandbox occurrence', () => {
  it('rejects an APPENDED second --sandbox workspace-write', () => {
    const argv = buildArgv()
    // Appended after the safe one, exactly as an attacker or a buggy caller
    // would add it. The prompt sentinel stays last.
    argv.splice(-1, 0, '--sandbox', 'workspace-write')
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_sandbox_mode')
  })

  it('rejects an appended second --sandbox even when its value is read-only', () => {
    // A duplicate is evidence the argv was not built by buildCodexPlanAuditPlan,
    // so it is refused on principle rather than tolerated as harmless.
    const argv = buildArgv()
    argv.splice(-1, 0, '--sandbox', 'read-only')
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_sandbox_mode')
  })

  it.each(['--sandbox=danger-full-access', '--sandbox=workspace-write', '-s=workspace-write'])(
    'rejects the inline form %s',
    (entry) => {
      const argv = buildArgv()
      argv.splice(-1, 0, entry)
      expect(findLaunchPlanViolation(argv)).toBe('unsafe_sandbox_mode')
    }
  )

  it('rejects the short -s form appended with an unsafe value', () => {
    const argv = buildArgv()
    argv.splice(-1, 0, '-s', 'danger-full-access')
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_sandbox_mode')
  })

  it('rejects a --sandbox with a MISSING value at the end of argv', () => {
    // The trailing '-' would otherwise be consumed as the sandbox value.
    const argv = [...buildArgv(), '--sandbox']
    expect(findLaunchPlanViolation(argv)).not.toBeNull()
  })

  it('rejects an inline --sandbox= with an empty value', () => {
    const argv = buildArgv()
    argv.splice(-1, 0, '--sandbox=')
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_sandbox_mode')
  })

  it('rejects a sandbox value that itself looks like a flag', () => {
    const argv = buildArgv()
    argv.splice(-1, 0, '--sandbox', '--ephemeral')
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_sandbox_mode')
  })
})

describe('findLaunchPlanViolation — every approval-policy occurrence', () => {
  it('rejects an appended conflicting approval policy', () => {
    const argv = buildArgv()
    argv.splice(-1, 0, '-c', 'approval_policy="on-request"')
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_approval_policy')
  })

  it('rejects a DUPLICATE approval policy even with the same safe value', () => {
    const argv = buildArgv()
    argv.splice(-1, 0, '-c', REQUIRED_APPROVAL_POLICY_ARG)
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_approval_policy')
  })

  it('rejects an approval policy set via the inline -c= form', () => {
    const argv = buildArgv()
    argv.splice(-1, 0, '-c=approval_policy="never"')
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_approval_policy')
  })

  it('rejects an approval policy set via --config', () => {
    const argv = buildArgv()
    argv.splice(-1, 0, '--config', 'approval_policy="untrusted"')
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_approval_policy')
  })

  it('rejects an approval policy with a MISSING value', () => {
    const argv = [...buildArgv(), '-c', 'approval_policy']
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_approval_policy')
  })

  it('does NOT confuse a similarly-named key with the approval policy', () => {
    // approval_policy_extra must not satisfy the required-override check, and
    // must not be mistaken for a conflicting one either — it is simply an
    // unknown key. Since the exhaustive allow-list landed it is refused as
    // `forbidden_flag_present` rather than tolerated: an audited launch carries
    // only the keys it needs, and "unrecognised" is not a reason to pass
    // something through to the CLI.
    const argv = buildArgv()
    argv.splice(-1, 0, '-c', 'approval_policy_extra="x"')
    expect(findLaunchPlanViolation(argv)).toBe('forbidden_flag_present')
  })
})

describe('findLaunchPlanViolation — sandbox via -c overrides', () => {
  it.each([
    ['sandbox_mode', 'sandbox_mode="danger-full-access"'],
    ['sandbox_permissions', 'sandbox_permissions=["disk-full-write-access"]']
  ])('rejects a %s config override that would outrank --sandbox', (_label, override) => {
    const argv = buildArgv()
    argv.splice(-1, 0, '-c', override)
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_sandbox_mode')
  })

  it('rejects a sandbox_mode override in the --config= inline form', () => {
    const argv = buildArgv()
    argv.splice(-1, 0, '--config=sandbox_mode="workspace-write"')
    expect(findLaunchPlanViolation(argv)).toBe('unsafe_sandbox_mode')
  })
})
