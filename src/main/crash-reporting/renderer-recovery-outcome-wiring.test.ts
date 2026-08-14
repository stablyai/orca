import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why a source-text test: the arm/disarm calls live in closures built inside
// openMainWindow(), and nothing can import src/main/index.ts (app-level side
// effects at module scope). Unit tests pin the module's behaviour; only this
// pins that index.ts still calls it, which a revert experiment showed no other
// test in src/main does.
describe('renderer recovery outcome wiring in index.ts', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  function sliceBlock(startAnchor: string, endAnchor: string, from = 0): string {
    const start = source.indexOf(startAnchor, from)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = source.indexOf(endAnchor, start)
    // Why: an unresolved end anchor slices to EOF and passes against unrelated code.
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  it('arms the outcome check on the auto-recovery reload', () => {
    const block = sliceBlock(
      'onBeforeRecoveryReload: (webContentsId) => {',
      "recordDurableCrashBreadcrumb('renderer_recovery_reload')"
    )

    expect(block).toContain('noteRendererRecoveryReloadIssued()')
  })

  it('disarms before prompting when the recovery breaker gives up', () => {
    const block = sliceBlock(
      'onRendererRecoveryExhausted: ({ details, recentRecoveryCount }) => {',
      'void presentRendererRecoveryPrompt(recentRecoveryCount)'
    )

    expect(block).toContain('clearRendererRecoveryReloadIssued()')
  })

  // Why this carries the invariant: every manual main-window reload marks an
  // expected reload, so disarming in the marker covers all of them at once —
  // including a future site that would otherwise repeat the round-5 miss.
  it('disarms inside markExpectedRendererReload itself', () => {
    const block = sliceBlock(
      'function markExpectedRendererReload(webContentsId: number, durationMs = 10_000): void {',
      '\nfunction clearExpectedRendererReload'
    )

    expect(block).toContain('clearRendererRecoveryReloadIssued()')
  })

  it('disarms on every user-initiated reload of the main window', () => {
    const reloadAnchor = 'onBeforeReload: ({ ignoreCache, webContentsId }) => {'
    // Why: createMainWindow's force-reload shortcut and the app menu wire this
    // separately, so a disarm on only one of them still mis-stamps the other.
    const firstStart = source.indexOf(reloadAnchor)
    const secondStart = source.indexOf(reloadAnchor, firstStart + reloadAnchor.length)
    expect(secondStart).toBeGreaterThan(firstStart)
    expect(source.indexOf(reloadAnchor, secondStart + reloadAnchor.length)).toBe(-1)

    for (const from of [firstStart, secondStart]) {
      const block = sliceBlock(
        reloadAnchor,
        "recordCrashBreadcrumb('manual_reload_requested', { ignoreCache })",
        from
      )
      // Why slice the guard rather than the whole block: the app menu reloads
      // whichever window has focus, so a disarm outside this check would let a
      // dashboard pop-out reload throw away the main renderer's pending arm.
      const guardStart = block.indexOf('if (mainWindow?.webContents.id === webContentsId) {')
      expect(guardStart).toBeGreaterThanOrEqual(0)
      const guard = block.slice(guardStart, block.lastIndexOf('}'))

      // The disarm rides on this call — see the markExpectedRendererReload test.
      expect(guard).toContain('markExpectedRendererReload(webContentsId)')
    }
  })

  // Why: `app:reload` is a third manual-reload path with a different callback
  // name, so the two `onBeforeReload` sites above do not cover it.
  it('disarms on the renderer-initiated app:reload of the main window', () => {
    const block = sliceBlock(
      'onBeforeRendererReload: ({ ignoreCache, webContentsId }) => {',
      "recordCrashBreadcrumb('renderer_reload_requested', { ignoreCache })"
    )
    const guardStart = block.indexOf('if (window.webContents.id === webContentsId) {')
    expect(guardStart).toBeGreaterThanOrEqual(0)
    const guard = block.slice(guardStart, block.lastIndexOf('}'))

    // The disarm rides on this call — see the markExpectedRendererReload test.
    expect(guard).toContain('markExpectedRendererReload(webContentsId)')
  })

  // Why: a replacement main window bootstraps a renderer the dead window's
  // recovery reload never produced, so it must not consume that window's arm.
  it('disarms before the first load of a replacement main window', () => {
    const block = sliceBlock("logStartupMilestone('load-start')", 'loadMainWindow(window)')

    expect(block).toContain('clearRendererRecoveryReloadIssued()')
  })
})
