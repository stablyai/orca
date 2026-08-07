import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { RECOVERY_RELOAD_INTENT_TTL_MS, createRecoveryReloadIntent } from './recovery-reload-intent'

describe('createRecoveryReloadIntent', () => {
  it('pins the production intent lifetime at 30 seconds', () => {
    expect(RECOVERY_RELOAD_INTENT_TTL_MS).toBe(30_000)
  })

  it('uses the monotonic clock by default', () => {
    const performanceNow = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValue(150)
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(100)
    const intent = createRecoveryReloadIntent({
      createToken: () => 'intent-1',
      durationMs: 50
    })

    intent.begin(7)
    intent.noteNavigationStarted(7)

    expect(intent.classifyLoad(7)).toBe('unknown')
    expect(performanceNow).toHaveBeenCalledTimes(2)
    expect(dateNow).not.toHaveBeenCalled()
  })

  it('classifies only the first post-intent navigation as recovery', () => {
    const intent = createRecoveryReloadIntent({
      now: () => 100,
      createToken: () => 'intent-1',
      durationMs: 50
    })

    expect(intent.begin(7)).toBe('intent-1')
    intent.noteNavigationStarted(7)

    expect(intent.classifyLoad(7)).toBe('recovery')
    expect(intent.classifyLoad(7)).toBe('unknown')
  })

  it('does not let an intervening load consume the intended recovery navigation', () => {
    const intent = createRecoveryReloadIntent({
      now: () => 100,
      createToken: () => 'intent-1',
      durationMs: 50
    })

    intent.begin(7)
    expect(intent.classifyLoad(7)).toBe('unknown')
    intent.noteNavigationStarted(7)

    expect(intent.classifyLoad(7)).toBe('recovery')
  })

  it('does not bind an intent to a navigation already in flight', () => {
    const intent = createRecoveryReloadIntent({
      now: () => 100,
      createToken: () => 'intent-1',
      durationMs: 50
    })

    intent.noteNavigationStarted(7)
    intent.begin(7)
    expect(intent.classifyLoad(7)).toBe('unknown')
    intent.noteNavigationStarted(7)

    expect(intent.classifyLoad(7)).toBe('recovery')
  })

  it('classifies an expired intended navigation as unknown', () => {
    let now = 100
    const intent = createRecoveryReloadIntent({
      now: () => now,
      createToken: () => 'intent-1',
      durationMs: 50
    })

    intent.begin(7)
    now = 150
    intent.noteNavigationStarted(7)

    expect(intent.classifyLoad(7)).toBe('unknown')
    expect(intent.cancel(7, 'intent-1')).toBe(false)
  })

  it('tracks concurrent recovery navigations per webContents', () => {
    let token = 0
    const intent = createRecoveryReloadIntent({
      now: () => 100,
      createToken: () => `intent-${++token}`,
      durationMs: 50
    })

    expect(intent.begin(7)).toBe('intent-1')
    expect(intent.begin(8)).toBe('intent-2')
    intent.noteNavigationStarted(7)
    intent.noteNavigationStarted(8)

    expect(intent.classifyLoad(7)).toBe('recovery')
    expect(intent.classifyLoad(8)).toBe('recovery')
  })

  it('requires an explicit arm to classify a load as ordinary', () => {
    const intent = createRecoveryReloadIntent({ now: () => 100 })

    expect(intent.classifyLoad(7)).toBe('unknown')
    intent.noteNavigationStarted(7)
    expect(intent.classifyLoad(7)).toBe('unknown')
    intent.armOrdinary(7)
    intent.noteNavigationStarted(7)
    expect(intent.classifyLoad(7)).toBe('ordinary')
    expect(intent.classifyLoad(7)).toBe('unknown')
  })

  it('classifies overlapping recovery and ordinary arms as unknown', () => {
    const intent = createRecoveryReloadIntent({
      now: () => 100,
      createToken: () => 'intent-1',
      durationMs: 50
    })

    intent.begin(7)
    intent.armOrdinary(7)
    intent.noteNavigationStarted(7)

    expect(intent.classifyLoad(7)).toBe('unknown')
  })

  it('cancels an ordinary arm before navigation starts', () => {
    const intent = createRecoveryReloadIntent({ now: () => 100, durationMs: 50 })
    intent.armOrdinary(7)
    intent.cancelOrdinary(7)
    intent.noteNavigationStarted(7)

    expect(intent.classifyLoad(7)).toBe('unknown')
  })

  // A vetoed reload is indistinguishable from a real one unless the veto path calls
  // cancelOrdinary; wiring that caller is the remaining work. See PR description.
  it.todo('does not retain an abandoned ordinary arm for a later navigation')

  it('does not retain a cancelled ordinary arm for a later navigation', () => {
    const intent = createRecoveryReloadIntent({ now: () => 100, durationMs: 50 })
    intent.armOrdinary(7)
    intent.cancelOrdinary(7)
    intent.noteNavigationStarted(7)

    expect(intent.classifyLoad(7)).toBe('unknown')
  })

  it('classifies overlapping navigations as unknown', () => {
    const intent = createRecoveryReloadIntent({ now: () => 100 })

    intent.noteNavigationStarted(7)
    intent.noteNavigationStarted(7)

    expect(intent.classifyLoad(7)).toBe('unknown')
  })

  it('cancels only the exact token from the originating webContents', () => {
    const intent = createRecoveryReloadIntent({
      now: () => 100,
      createToken: () => 'intent-1',
      durationMs: 50
    })

    intent.begin(7)
    expect(intent.cancel(7, 'stale')).toBe(false)
    expect(intent.cancel(8, 'intent-1')).toBe(false)
    expect(intent.cancel(7, 'intent-1')).toBe(true)
    intent.noteNavigationStarted(7)
    expect(intent.classifyLoad(7)).toBe('unknown')
  })

  it('restarts the expiry window after an injected clock rollback', () => {
    let now = 100
    const intent = createRecoveryReloadIntent({
      now: () => now,
      createToken: () => 'intent-1',
      durationMs: 50
    })

    intent.begin(7)
    now = 120
    expect(intent.cancel(8, 'intent-1')).toBe(false)
    now = 90
    expect(intent.cancel(8, 'intent-1')).toBe(false)
    now = 139
    intent.noteNavigationStarted(7)

    expect(intent.classifyLoad(7)).toBe('recovery')
  })
})
