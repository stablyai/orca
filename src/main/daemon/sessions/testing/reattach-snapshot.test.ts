import '../../pty-subprocess/testing/mock-descendant-sweep'
import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../../emulation/headless-emulator'

// This fixture assembles the payload locally; it does not exercise the adapter’s assembly.
function buildReattachPayload(snapshot: ReturnType<HeadlessEmulator['getSnapshot']>) {
  const isAltScreen = snapshot.modes.alternateScreen
  const fullPayload = snapshot.scrollbackAnsi + snapshot.rehydrateSequences + snapshot.snapshotAnsi
  return {
    rehydrateSequences: snapshot.rehydrateSequences,
    snapshotAnsi: snapshot.snapshotAnsi,
    fullPayload,
    isAlternateScreen: isAltScreen,
    cols: snapshot.cols,
    rows: snapshot.rows
  }
}

describe('reattach snapshot flow', () => {
  describe('alternate-screen TUI (Codex style)', () => {
    it('returns to preserved shell history after the reattached TUI exits', async () => {
      const emulator = new HeadlessEmulator({ cols: 80, rows: 10 })
      await emulator.write('shell output before Codex\r\n$ codex')
      await emulator.write('\x1b[?1049h\x1b[2J\x1b[HCodex TUI content')
      const payload = buildReattachPayload(emulator.getSnapshot())
      emulator.dispose()

      const replay = new HeadlessEmulator({ cols: 80, rows: 10 })
      try {
        await replay.write(payload.fullPayload)
        expect(replay.getVisibleLines().join('\n')).toContain('Codex TUI content')
        await replay.write('\x1b[?1049l')
        expect(replay.getVisibleLines().join('\n')).toContain('shell output before Codex')
      } finally {
        replay.dispose()
      }
    })
  })
})
