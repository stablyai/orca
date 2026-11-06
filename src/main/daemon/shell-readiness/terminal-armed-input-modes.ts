// Exclude prompt-owned ?2004/?1 and zle’s ESC =; track keypad mode only through ?66.
const TRACKED_PRIVATE_MODES = new Set([9, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 66])
// ConPTY enables focus reporting at startup and after RIS.
const HOST_ARMABLE_MODE = 1004
// Kitty flags and their ownership are per screen.
type ModeKey = number | 'kitty-main' | 'kitty-alt' | 'modify-other-keys'
// Host focus survives grounding; prompt enables await C; command modes trigger recovery; stale modes only clear.
type ModeOwner = 'host' | 'prompt' | 'command' | 'stale'
// Matches xterm.js's eviction limit, so the model drops the same entries.
const KITTY_STACK_LIMIT = 16

export class TerminalArmedInputModes {
  private readonly owners = new Map<ModeKey, ModeOwner>()
  // Without OSC 133;C, no new enable belongs to a command.
  private enableOwner: 'host' | 'prompt' | 'command' = 'host'
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
      // Changed flags belong to the current writer; unchanged flags retain ownership.
      this.owners.set(this.kittyKey(), this.ownerForEnable(this.kittyKey()))
    }
  }

  applyModifyOtherKeys(level: number): void {
    this.setArmed('modify-other-keys', level > 0)
  }

  /** A command start proves prompt-owned focus is the host’s; other prompt modes become stale. */
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

  /** Retain command ownership so a nested shell’s refuted D cannot hide the eventual real exit. */
  markCommandEnd(): boolean {
    let left = false
    for (const [key, owner] of this.owners) {
      // The other screen's kitty flags stay parked in xterm and reach no input.
      left ||=
        owner === 'command' &&
        (typeof key === 'number' || key === 'modify-other-keys' || key === this.kittyKey())
      if (owner === 'prompt') {
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

  // Preserve known ownership when a pop or screen swap uncovers earlier flags.
  private uncoverKittyFlags(): void {
    if (this.kittyFlags === 0) {
      this.owners.delete(this.kittyKey())
    } else if (!this.owners.has(this.kittyKey())) {
      this.owners.set(this.kittyKey(), this.ownerForEnable(this.kittyKey()))
    }
  }

  private setArmed(key: ModeKey, armed: boolean): void {
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
