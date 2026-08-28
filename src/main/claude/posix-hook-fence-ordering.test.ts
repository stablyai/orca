import { describe, expect, it } from 'vitest'
import { buildClaudePosixHookScript } from './posix-hook-script'

/** The offline fence is the only fence left when Orca is unreachable, so every
 *  early exit has to consult it first. The backgrounded-job guard exited above
 *  the fence — before the function was even defined — so a background job could
 *  mutate a workspace under an active validation lease.
 */
describe('every early exit consults the offline fence', () => {
  const script = buildClaudePosixHookScript({})
  // The Devin guard only exists in this variant, and it is the variant Orca
  // installs for every Claude session (`agent === 'claude'`).
  const devinScript = buildClaudePosixHookScript({ skipWhenDevinImportsClaude: true })

  it('defines the fence before the backgrounded-job guard runs', () => {
    const fenceDefined = script.indexOf('orca_fence_denies() {')
    const jobGuard = script.indexOf('if [ -n "$CLAUDE_JOB_DIR" ]')
    expect(fenceDefined).toBeGreaterThan(-1)
    expect(jobGuard).toBeGreaterThan(-1)
    expect(jobGuard).toBeGreaterThan(fenceDefined)
  })

  it('calls the fence on the backgrounded-job path before exiting', () => {
    const jobGuard = script.indexOf('if [ -n "$CLAUDE_JOB_DIR" ]')
    const block = script.slice(jobGuard, jobGuard + 120)
    expect(block).toContain('orca_fence_denies')
    expect(block.indexOf('orca_fence_denies')).toBeLessThan(block.indexOf('exit 0'))
  })

  it('still consults the fence when the endpoint is unusable', () => {
    const guard = script.indexOf('if [ -z "$ORCA_AGENT_HOOK_PORT" ]')
    expect(script.slice(guard, guard + 200)).toContain('orca_fence_denies')
  })

  it('defines the fence before the Devin guard runs', () => {
    const fenceDefined = devinScript.indexOf('orca_fence_denies() {')
    const devinGuard = devinScript.indexOf('if [ -n "$DEVIN_PROJECT_DIR" ]')
    expect(devinGuard).toBeGreaterThan(-1)
    expect(devinGuard).toBeGreaterThan(fenceDefined)
  })

  it('calls the fence on the Devin path before exiting', () => {
    // Skipping the status post is right; skipping the mutation fence is not.
    const devinGuard = devinScript.indexOf('if [ -n "$DEVIN_PROJECT_DIR" ]')
    const block = devinScript.slice(devinGuard, devinGuard + 120)
    expect(block).toContain('orca_fence_denies')
    expect(block.indexOf('orca_fence_denies')).toBeLessThan(block.indexOf('exit 0'))
  })
})
