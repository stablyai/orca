// Input modes a program arms for itself and must disarm on exit. `?2004` and `?1`
// are left out because bash, zsh and PowerShell arm them at their own prompts.
// `?66` is DECNKM, not `ESC =`: zle's smkx (`ESC[?1h ESC=`) stays untracked.
const TRACKED_PRIVATE_MODES = new Set([9, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 66])
// The one mode a terminal host arms for itself: ConPTY sends ?1004h at pane start and after RIS.
const HOST_ARMABLE_MODE = 1004
// Why one key per screen: kitty flags are per screen, so ownership must be too.
type ModeKey = number | 'kitty-main' | 'kitty-alt'
// host: HOST_ARMABLE_MODE armed before any marker or by a prompt a 133;C proved; the ground keeps it.
// prompt: armed outside a command, unproven until C.
// command: armed after C; still on at 133;D, it triggers the ground.
// stale: anything else still on; the ground clears it without it ever triggering.
type ModeOwner = 'host' | 'prompt' | 'command' | 'stale'
// Matches xterm.js's eviction limit, so the model drops the same entries.
const KITTY_STACK_LIMIT = 16

/**
 * Who armed each tracked input mode. A command that ends with a mode it armed
 * still on leaves that mode to the recovery barrier's ground, which keeps only
 * host-owned focus reporting.
 */
export class TerminalArmedInputModes {
  // Keys are exactly the armed modes.
  private readonly owners = new Map<ModeKey, ModeOwner>()
  // Who an enable arriving now belongs to ('host' = before any marker). Without a 133;C nothing is a command's.
  private enableOwner: 'host' | 'prompt' | 'command' = 'host'
  // Mirrors xterm.js's kitty state: current flags, the other screen's flags, and a stack per screen.
  private kittyFlags = 0
  private kittyMainFlags = 0
  private kittyAltFlags = 0
  private kittyMainStack: number[] = []
  private kittyAltStack: number[] = []
  private onAlternateScreen = false

  get hostOwnsFocusReporting(): boolean {
    return this.owners.get(HOST_ARMABLE_MODE) === 'host'
  }

  applyPrivateMode(param: number, enabled: boolean): void {
    if (TRACKED_PRIVATE_MODES.has(param)) {
      this.setArmed(param, enabled)
    }
  }

  /** `?47`/`?1047`/`?1049`: xterm swaps the kitty flags on every set or reset. */
  switchScreen(alternate: boolean): void {
    if (alternate) {
      this.kittyMainFlags = this.kittyFlags
      this.kittyFlags = this.kittyAltFlags
    } else {
      this.kittyAltFlags = this.kittyFlags
      this.kittyFlags = this.kittyMainFlags
    }
    this.onAlternateScreen = alternate
    this.uncoverKittyFlags()
  }

  /** `CSI > flags u` push, `CSI < n u` pop, `CSI = flags ; mode u` set. */
  applyKittyKeyboard(prefix: string, params: string): void {
    const separator = params.indexOf(';')
    const first = Number(separator === -1 ? params : params.slice(0, separator)) || 0
    const stack = this.onAlternateScreen ? this.kittyAltStack : this.kittyMainStack
    const before = this.kittyFlags
    if (prefix === '<') {
      for (let count = Math.max(1, first); count > 0 && stack.length > 0; count -= 1) {
        this.kittyFlags = stack.pop() ?? 0
      }
      if (stack.length === 0) {
        this.kittyFlags = 0
      }
      this.uncoverKittyFlags()
      return
    }
    if (prefix === '>') {
      if (stack.length >= KITTY_STACK_LIMIT) {
        stack.shift()
      }
      stack.push(this.kittyFlags)
      this.kittyFlags = first
    } else {
      const mode = separator === -1 ? 1 : Number(params.slice(separator + 1)) || 1
      this.kittyFlags =
        mode === 2 ? this.kittyFlags | first : mode === 3 ? this.kittyFlags & ~first : first
    }
    if (this.kittyFlags === 0) {
      this.owners.delete(this.kittyKey())
    } else if (this.kittyFlags !== before) {
      // Why no host stickiness: new flags are a new writer's, not a repeat.
      this.owners.set(this.kittyKey(), this.ownerForEnable(this.kittyKey()))
    }
  }

  /** OSC 133;C: the prompt's enables were the host's; later ones are the command's. */
  markCommandStart(): void {
    for (const [key, owner] of this.owners) {
      if (owner === 'prompt') {
        this.owners.set(key, key === HOST_ARMABLE_MODE ? 'host' : 'stale')
      }
    }
    this.enableOwner = 'command'
  }

  markPrompt(): void {
    this.enableOwner = 'prompt'
  }

  /** OSC 133;D: true when the command left a mode it armed. Demoting makes it one-shot. */
  markCommandEnd(): boolean {
    let left = false
    for (const [key, owner] of this.owners) {
      if (owner === 'command' || owner === 'prompt') {
        // The other screen's kitty flags stay parked in xterm and reach no input.
        left ||= owner === 'command' && (typeof key === 'number' || key === this.kittyKey())
        this.owners.set(key, 'stale')
      }
    }
    this.enableOwner = 'prompt'
    return left
  }

  /** `ESC c`: modes go off but host focus ownership stands (ConPTY re-sends ?1004h). */
  reset(): void {
    for (const [key, owner] of this.owners) {
      if (owner !== 'host') {
        this.owners.delete(key)
      }
    }
    this.kittyFlags = 0
    this.kittyMainFlags = 0
    this.kittyAltFlags = 0
    this.kittyMainStack = []
    this.kittyAltStack = []
    this.onAlternateScreen = false
  }

  private kittyKey(): ModeKey {
    return this.onAlternateScreen ? 'kitty-alt' : 'kitty-main'
  }

  // Why no claim when already armed: a pop or screen swap only uncovers flags an earlier writer set.
  private uncoverKittyFlags(): void {
    if (this.kittyFlags === 0) {
      this.owners.delete(this.kittyKey())
    } else if (!this.owners.has(this.kittyKey())) {
      this.owners.set(this.kittyKey(), this.ownerForEnable(this.kittyKey()))
    }
  }

  private setArmed(key: number, armed: boolean): void {
    if (!armed) {
      this.owners.delete(key)
    } else if (this.owners.get(key) !== 'host') {
      // Host arming is sticky: a program re-sending the host's enable is a wire no-op.
      this.owners.set(key, this.ownerForEnable(key))
    }
  }

  private ownerForEnable(key: ModeKey): ModeOwner {
    return this.enableOwner === 'host' && key !== HOST_ARMABLE_MODE ? 'prompt' : this.enableOwner
  }
}
