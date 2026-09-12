import { describe, expect, it, vi } from 'vitest'
import { isWorkflowScopeTimeout, pushRef, recoveryRunbook } from './push-release-ref.mjs'

// The verbatim rejection GitHub returned on the three wedged v1.4.198 cuts.
const SCOPE_REJECTION =
  ' ! [remote rejected] v1.4.198 -> v1.4.198 (Unable to determine if workflow can be ' +
  'created or updated due to timeout; `workflows` scope may be required.)'
const UNRELATED_REJECTION =
  'error: failed to push some refs\nhint: Updates were rejected because the remote contains work'

const ok = () => ({ ok: true, output: ' * [new tag] v1.4.198 -> v1.4.198' })
const fails = (output) => ({ ok: false, output })
const noWait = () => Promise.resolve()

describe('isWorkflowScopeTimeout', () => {
  it('matches the rejection GitHub actually returns', () => {
    expect(isWorkflowScopeTimeout(SCOPE_REJECTION)).toBe(true)
  })

  it('does not match an ordinary rejection', () => {
    expect(isWorkflowScopeTimeout(UNRELATED_REJECTION)).toBe(false)
  })
})

describe('pushRef', () => {
  it('pushes once when the remote accepts it', async () => {
    const push = vi.fn(async () => ok())
    await expect(pushRef('v1.4.198', { push, wait: noWait })).resolves.toMatchObject({
      ok: true,
      attempts: 1
    })
    expect(push).toHaveBeenCalledTimes(1)
  })

  // Why this case earns its place: retrying a real rejection three times turns a
  // clear failure into a slow, confusing one.
  it('surfaces an unrelated failure on the first attempt without retrying', async () => {
    const push = vi.fn(async () => fails(UNRELATED_REJECTION))
    const result = await pushRef('v1.4.198', { push, wait: noWait })
    expect(result).toMatchObject({ ok: false, attempts: 1, workflowScopeTimeout: false })
    expect(push).toHaveBeenCalledTimes(1)
  })

  // The determination is a timeout, so it is load-sensitive and can clear.
  it('retries the scope timeout and succeeds when a later attempt clears', async () => {
    const push = vi
      .fn()
      .mockResolvedValueOnce(fails(SCOPE_REJECTION))
      .mockResolvedValueOnce(fails(SCOPE_REJECTION))
      .mockResolvedValueOnce(ok())
    const onRetry = vi.fn()
    await expect(pushRef('v1.4.198', { push, wait: noWait, onRetry })).resolves.toMatchObject({
      ok: true,
      attempts: 3
    })
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('gives up after the bounded attempts and reports it as a scope timeout', async () => {
    const push = vi.fn(async () => fails(SCOPE_REJECTION))
    const result = await pushRef('v1.4.198', { push, wait: noWait, attempts: 3 })
    expect(result).toMatchObject({ ok: false, attempts: 3, workflowScopeTimeout: true })
    expect(push).toHaveBeenCalledTimes(3)
  })
})

describe('recoveryRunbook', () => {
  // Why assert this: a re-run silently makes the Windows job skip its artifact
  // build, so the operator must be told to re-dispatch instead.
  it('tells the operator to re-dispatch rather than re-run', () => {
    const runbook = recoveryRunbook('v1.4.198', 'abc1234')
    expect(runbook).toContain('RELEASE_PUSH_TOKEN')
    expect(runbook).toContain('abc1234')
    expect(runbook).toMatch(/re-dispatch, do not re-run/i)
  })
})
