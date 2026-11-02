import { closesAppOsc133Zone } from '../../shared/terminal-osc133-command-finished'

/** OSC 133 hint that a shell sits at its prompt. Apps print these markers too (#10923), so any
 * doubt is 'unknown' and only a clean C → D;0 → A cycle at the shell's own depth reaches 'prompt'. */
export class TerminalShellPromptPhase {
  private phase: 'unknown' | 'command' | 'ended' | 'prompt' = 'unknown'
  // Zones an app or nested shell opened inside the shell's command; their D closes them, not it.
  private nestedZones = 0

  get atPrompt(): boolean {
    return this.phase === 'prompt'
  }

  reset(): void {
    this.phase = 'unknown'
    this.nestedZones = 0
  }

  observe(payload: string, adjacentMarkersBefore: string): void {
    const marker = payload[0]
    if (this.phase === 'command') {
      if (marker === 'A' || (marker === 'C' && this.nestedZones === 0)) {
        this.nestedZones += 1
      } else if (marker === 'D' && this.nestedZones > 0) {
        this.nestedZones -= 1
      } else if (marker === 'D') {
        // A failed or unlabeled exit, or an app-closed zone, is doubt rather than a shell return.
        const clean = payload === 'D;0' && !closesAppOsc133Zone(adjacentMarkersBefore, payload)
        this.phase = clean ? 'ended' : 'unknown'
      }
      return
    }
    if (marker === 'C') {
      this.phase = 'command'
      this.nestedZones = 0
    } else if (marker === 'A') {
      this.phase = this.phase === 'ended' || this.phase === 'prompt' ? 'prompt' : 'unknown'
    } else if (marker === 'D') {
      this.phase = 'unknown'
    }
  }
}
