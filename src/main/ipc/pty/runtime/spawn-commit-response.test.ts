import { describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { reportRuntimeResumeOutcome } from './spawn-commit-response'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

type Facts = { resumed?: boolean; unavailable?: boolean; dropped?: boolean; isReattach?: boolean }

function reply({ resumed = false, unavailable = false, dropped = false, isReattach }: Facts) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the report reads no deps.
  const deps = {} as unknown as PtyRuntimeControllerDeps
  const onResumeOutcome = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the report reads only the resume asked for and its sink.
  const args = {
    cols: 120,
    rows: 40,
    onResumeOutcome,
    ...(resumed ? { resumeProviderSession: { key: 'session_id', id: 'codex-session-1' } } : {})
  } as unknown as RuntimePtySpawnArgs
  const ctx = createRuntimePtySpawnState(deps, args)
  ctx.result = { id: 'pty-1', ...(isReattach ? { isReattach } : {}) }
  ctx.codexResumeUnavailable = unavailable
  ctx.codexResumeArgvDropped = dropped || unavailable
  reportRuntimeResumeOutcome(ctx)
  return {
    resumeOutcome: onResumeOutcome.mock.calls[0]?.[1],
    ptyId: onResumeOutcome.mock.calls[0]?.[0]
  }
}

describe("a runtime spawn's resume outcome", () => {
  const on = <T>(value: T): T | undefined => (ORCA_LAYOUT_OWNER_IS_MAIN ? value : undefined)

  it('says a resumed start restored its agent, switch-on only', () => {
    expect(reply({ resumed: true })).toEqual({ resumeOutcome: on('restored'), ptyId: on('pty-1') })
  })

  it('says a start whose unverified resume was dropped runs a fresh session', () => {
    expect(reply({ resumed: true, unavailable: true }).resumeOutcome).toBe(on('resume-unavailable'))
  })

  it('says nothing for a plain start, a silently dropped resume, or a reattach', () => {
    expect(reply({}).resumeOutcome).toBeUndefined()
    expect(reply({ resumed: true, dropped: true }).resumeOutcome).toBeUndefined()
    expect(reply({ resumed: true, isReattach: true }).resumeOutcome).toBeUndefined()
  })
})
