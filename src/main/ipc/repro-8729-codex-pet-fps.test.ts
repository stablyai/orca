/**
 * Issue #8729 — imported .codex-pet bundles ignore per-frame durations; uniform 8 fps.
 *
 * Codex idle frame ms: [1680, 660, 660, 840, 840, 1920] ≈ 6.6s cycle.
 * Orca applyCodexPetDefaults only stores { row, frames } + sheet-wide fps=8 →
 * 6 frames / 8 fps = 0.75s cycle (~9× too fast).
 *
 * Synthetic fixture only — never load issue attachments.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/ipc/repro-8729-codex-pet-fps.test.ts
 */
import { describe, expect, it } from 'vitest'
import { applyCodexPetDefaults, CODEX_PET_DEFAULT_FPS, CODEX_PET_ANIMATIONS } from './pet-bundle'

/** Codex-documented idle hold times (ms) from issue #8729 / codex-rs pets model. */
const CODEX_IDLE_FRAME_MS = [1680, 660, 660, 840, 840, 1920] as const

function cycleMsFromUniformFps(frames: number, fps: number): number {
  return (frames / fps) * 1000
}

function cycleMsFromPerFrame(ms: readonly number[]): number {
  return ms.reduce((a, b) => a + b, 0)
}

describe('issue #8729 codex-pet frame timing', () => {
  it('defaults codex layout to sheet-wide 8 fps without per-frame durations', () => {
    const manifest = applyCodexPetDefaults({ id: 'repro-pet', displayName: 'Repro' })
    expect(manifest.fps).toBe(CODEX_PET_DEFAULT_FPS)
    expect(manifest.fps).toBe(8)
    expect(manifest.animations?.idle).toEqual({ row: 0, frames: 6 })
    // No durationMs / frameDurations field on animation rows
    expect(manifest.animations?.idle).not.toHaveProperty('durationMs')
    expect(manifest.animations?.idle).not.toHaveProperty('frameDurations')
  })

  it('proves 8 fps cycle is ~9× faster than Codex idle per-frame holds', () => {
    const frames = CODEX_PET_ANIMATIONS.idle.frames
    const orcaMs = cycleMsFromUniformFps(frames, CODEX_PET_DEFAULT_FPS)
    const codexMs = cycleMsFromPerFrame(CODEX_IDLE_FRAME_MS)
    expect(orcaMs).toBe(750)
    expect(codexMs).toBe(6600)
    expect(codexMs / orcaMs).toBeCloseTo(8.8, 1)
  })
})
