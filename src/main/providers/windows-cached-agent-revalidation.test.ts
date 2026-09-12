import { describe, expect, it } from 'vitest'
import {
  canRevalidateCachedAgentWithoutScan,
  judgeCachedAgentJobEvidence,
  WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS
} from './windows-cached-agent-revalidation'

describe('canRevalidateCachedAgentWithoutScan', () => {
  it('is true for a cached agent when node-pty only names the shell (a scan would run)', () => {
    expect(canRevalidateCachedAgentWithoutScan('claude', 'powershell.exe')).toBe(true)
    expect(canRevalidateCachedAgentWithoutScan('codex', 'cmd.exe')).toBe(true)
  })

  it('is false when node-pty already names a recognized agent (no scan needed)', () => {
    // Nothing to save here — the fast no-scan path already returns the agent.
    expect(canRevalidateCachedAgentWithoutScan('claude', 'claude')).toBe(false)
  })

  it('is false for a generic wrapper that may outlive the cached agent', () => {
    expect(canRevalidateCachedAgentWithoutScan('claude', 'node.exe')).toBe(false)
  })

  it('is false when no agent has been recognized yet (identity must be established first)', () => {
    expect(canRevalidateCachedAgentWithoutScan(null, 'powershell.exe')).toBe(false)
  })

  it('is false when there is no fallback process name', () => {
    expect(canRevalidateCachedAgentWithoutScan('claude', null)).toBe(false)
  })
})

describe('judgeCachedAgentJobEvidence', () => {
  const SHELL = 12345
  const AGENT = 999
  const FRESH = 1_000
  const AGED = WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS + 1

  const judge = (
    jobProcessIds: ReadonlySet<number> | null,
    anchorProcessId: number | null,
    identityAgeMs: number
  ) =>
    judgeCachedAgentJobEvidence({
      jobProcessIds,
      shellPid: SHELL,
      anchorProcessId,
      identityAgeMs
    })

  it('defers to the scan when the build has no job exports to consult', () => {
    // Every shipped Windows release still ships a node-pty without them
    // (#16059), so the read is null for ALL real users today. Calling that
    // 'unavailable' means the retire path never fires for any of them -- worse
    // than the forked probe it replaced, which at least retired. 'unsupported'
    // is "nothing to ask", not "asked and could not", so the scan decides.
    const unsupported = (anchorProcessId: number | null, identityAgeMs: number) =>
      judgeCachedAgentJobEvidence({
        jobProcessIds: null,
        jobSupported: false,
        shellPid: SHELL,
        anchorProcessId,
        identityAgeMs
      })

    expect(unsupported(AGENT, FRESH)).toBe('unsupported')
    expect(unsupported(null, AGED)).toBe('unsupported')
  })

  it('is unavailable without a job answer, never exit proof', () => {
    // Supported-but-null is genuine loss of contact and must still hold.
    expect(judge(null, AGENT, FRESH)).toBe('unavailable')
    expect(judge(null, null, AGED)).toBe('unavailable')
    expect(
      judgeCachedAgentJobEvidence({
        jobProcessIds: null,
        jobSupported: true,
        shellPid: SHELL,
        anchorProcessId: AGENT,
        identityAgeMs: AGED
      })
    ).toBe('unavailable')
  })

  it('confirms a fresh anchored identity whose pid is still in the job', () => {
    expect(judge(new Set([SHELL, AGENT]), AGENT, FRESH)).toBe('confirmed')
  })

  it('asks for a drift recheck once an anchored identity ages, without retiring it', () => {
    expect(judge(new Set([SHELL, AGENT]), AGENT, AGED)).toBe('recheck')
  })

  it('downgrades an anchored identity when its pid leaves a job that still has members', () => {
    // The survivor is a detached leftover OR the agent's restarted successor;
    // only a scan can tell, so the verdict must not be a hard exit.
    expect(judge(new Set([SHELL, 777]), AGENT, FRESH)).toBe('anchor-exited')
  })

  it('retires any identity when the shell stands alone', () => {
    expect(judge(new Set([SHELL]), AGENT, FRESH)).toBe('exited')
    expect(judge(new Set([SHELL]), null, FRESH)).toBe('exited')
  })

  it('bounds unanchored superset evidence by age', () => {
    expect(judge(new Set([SHELL, 777]), null, FRESH)).toBe('unproven')
    expect(judge(new Set([SHELL, 777]), null, AGED)).toBe('expired')
  })

  it('treats a shell-pid anchor as unanchored', () => {
    // The shell being alive proves nothing about the agent.
    expect(judge(new Set([SHELL, 777]), SHELL, FRESH)).toBe('unproven')
  })
})
