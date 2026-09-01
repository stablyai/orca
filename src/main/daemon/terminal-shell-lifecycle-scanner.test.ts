import { describe, expect, it } from 'vitest'
import { POST_REPLAY_DEAD_TUI_RESET } from '../../shared/terminal-mode-reset-profiles'
import { TerminalShellLifecycleScanner } from './terminal-shell-lifecycle-scanner'

const ENTER_ALT = '\x1b[?1049h'
const LEAVE_ALT = '\x1b[?1049l'

describe('TerminalShellLifecycleScanner', () => {
  describe('unclean death trigger', () => {
    it('stops at the OSC 133;D terminator while the alternate screen is up', () => {
      const scanner = new TerminalShellLifecycleScanner()
      const chunk = `${ENTER_ALT}TUI\x1b]133;D;137\x07shell-marker`

      const events = scanner.scan(chunk)

      expect(events.uncleanDeathTriggerEnd).toBe(chunk.indexOf('shell-marker'))
      expect(chunk.slice(events.uncleanDeathTriggerEnd)).toBe('shell-marker')
      expect(scanner.isAlternateScreenActive).toBe(true)
      expect(scanner.owner).toBeUndefined()
      expect(events.cleanExitCandidate).toBeUndefined()
    })

    it('does not consume bytes past the trigger', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.scan(`${ENTER_ALT}TUI\x1b]133;D;137\x07shell-marker`)

      expect(scanner.scan('shell-marker')).toEqual({})
    })

    it('carries no partial sequence out of the trigger', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.scan(`${ENTER_ALT}TUI\x1b]133;D;137\x07\x1b[?10`)
      const generation = scanner.generation

      // A leaked tail would compose with this into `\x1b[?1049h` and revoke again.
      expect(scanner.scan('49h')).toEqual({})
      expect(scanner.generation).toBe(generation)
    })

    it('reports a chunk-local index when the sequence spans three chunks', () => {
      const scanner = new TerminalShellLifecycleScanner()

      expect(scanner.scan('\x1b[?10')).toEqual({})
      expect(scanner.scan('49hTUI\x1b]133;D;1')).toEqual({})
      const events = scanner.scan('37\x07tail')

      expect(events.uncleanDeathTriggerEnd).toBe('37\x07'.length)
      expect('37\x07tail'.slice(events.uncleanDeathTriggerEnd)).toBe('tail')
      expect(scanner.owner).toBeUndefined()
    })

    it('accepts an ST-terminated OSC', () => {
      const scanner = new TerminalShellLifecycleScanner()
      const chunk = `${ENTER_ALT}TUI\x1b]133;D;137\x1b\\rest`

      const events = scanner.scan(chunk)

      expect(events.uncleanDeathTriggerEnd).toBe(chunk.indexOf('rest'))
    })

    it('accepts an ST split across chunks', () => {
      const scanner = new TerminalShellLifecycleScanner()

      expect(scanner.scan(`${ENTER_ALT}TUI\x1b]133;D;137\x1b`)).toEqual({})
      const events = scanner.scan('\\rest')

      expect(events.uncleanDeathTriggerEnd).toBe(1)
    })

    it('fires again on the re-fed remainder', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.scan(`${ENTER_ALT}TUI\x1b]133;D;137\x07REMAINDER`)

      // The remainder starts a fresh TUI that dies the same way.
      expect(scanner.scan(LEAVE_ALT)).toEqual({})
      const again = scanner.scan(`${ENTER_ALT}AGAIN\x1b]133;D;9\x07`)

      expect(again.uncleanDeathTriggerEnd).toBe(`${ENTER_ALT}AGAIN\x1b]133;D;9\x07`.length)
    })
  })

  describe('clean exit candidates', () => {
    it('offers ownership after a TUI leaves the alternate screen and the command ends', () => {
      const scanner = new TerminalShellLifecycleScanner()

      const events = scanner.scan(`${ENTER_ALT}TUI${LEAVE_ALT}\x1b]133;D;0\x07`)

      expect(events.uncleanDeathTriggerEnd).toBeUndefined()
      const candidate = events.cleanExitCandidate
      expect(candidate).toBeDefined()
      expect(scanner.owner).toBeUndefined()
      expect(scanner.trySetOwner(candidate!.generation)).toBe(true)
      expect(scanner.owner).toBe('shell')
      expect(scanner.isAlternateScreenActive).toBe(false)
    })

    it('invalidates the candidate when output arrives before the owner is set', () => {
      const scanner = new TerminalShellLifecycleScanner()
      const candidate = scanner.scan(
        `${ENTER_ALT}TUI${LEAVE_ALT}\x1b]133;D;0\x07`
      ).cleanExitCandidate

      scanner.scan('\x1b]133;C\x07')

      expect(scanner.trySetOwner(candidate!.generation)).toBe(false)
      expect(scanner.owner).toBeUndefined()
    })

    it('does not let a candidate survive a TUI started later in the same chunk', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.scan(`${ENTER_ALT}TUI${LEAVE_ALT}`)

      const candidate = scanner.scan(`\x1b]133;D;0\x07${ENTER_ALT}LIVE`).cleanExitCandidate

      expect(candidate).toBeDefined()
      expect(scanner.trySetOwner(candidate!.generation)).toBe(false)
      expect(scanner.owner).toBeUndefined()
    })

    it('emits nothing for a command that never entered the alternate screen', () => {
      const scanner = new TerminalShellLifecycleScanner()

      const events = scanner.scan(`\x1b]133;D;0\x07${ENTER_ALT}LIVE`)

      expect(events).toEqual({})
    })

    it('forgets the alternate-screen visit once a new command starts', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.scan(`${ENTER_ALT}TUI${LEAVE_ALT}`)

      scanner.scan('\x1b]133;C\x07')

      expect(scanner.scan('\x1b]133;D;0\x07')).toEqual({})
    })

    it('emits no candidate for an ordinary command completion', () => {
      const scanner = new TerminalShellLifecycleScanner()

      expect(scanner.scan('\x1b]133;D;0\x07')).toEqual({})
    })

    it('keeps only the last candidate of a chunk', () => {
      const scanner = new TerminalShellLifecycleScanner()

      const events = scanner.scan(
        `${ENTER_ALT}a${LEAVE_ALT}\x1b]133;D;0\x07${ENTER_ALT}b${LEAVE_ALT}\x1b]133;D;0\x07`
      )

      expect(events.cleanExitCandidate?.generation).toBe(scanner.generation)
      expect(scanner.trySetOwner(events.cleanExitCandidate!.generation)).toBe(true)
    })
  })

  describe('revocation', () => {
    it('revokes on a mouse-only DECSET', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.seedOwner('shell')

      scanner.scan('\x1b[?1003h')

      expect(scanner.owner).toBeUndefined()
      expect(scanner.isAlternateScreenActive).toBe(false)
    })

    it('revokes on a kitty keyboard push', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.seedOwner('shell')

      scanner.scan('\x1b[>1u')

      expect(scanner.owner).toBeUndefined()
    })

    it('ignores the kitty pop and clear forms we inject ourselves', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.seedOwner('shell')
      const generation = scanner.generation

      scanner.scan('\x1b[<99u\x1b[=0u')

      expect(scanner.owner).toBe('shell')
      expect(scanner.generation).toBe(generation)
    })

    it('revokes on every command boundary, not just ones touching the alternate screen', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.seedOwner('shell')
      const generation = scanner.generation

      scanner.scan('\x1b]133;D;0\x07')

      expect(scanner.owner).toBeUndefined()
      expect(scanner.generation).toBe(generation + 1)

      scanner.trySetOwner(scanner.generation)
      scanner.scan('\x1b]133;C\x07')

      expect(scanner.owner).toBeUndefined()
    })

    it('revokes and clears alternate-screen state on RIS', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.scan(ENTER_ALT)
      scanner.seedOwner('shell')

      scanner.scan('\x1bc')

      expect(scanner.owner).toBeUndefined()
      expect(scanner.isAlternateScreenActive).toBe(false)
      // The cleared flag means a later D is a plain completion, not a clean exit.
      expect(scanner.scan('\x1b]133;D;0\x07')).toEqual({})
    })

    it('recognizes the 8-bit CSI introducer', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.seedOwner('shell')

      scanner.scan('\x9b?1049h')

      expect(scanner.owner).toBeUndefined()
      expect(scanner.isAlternateScreenActive).toBe(true)
    })

    it('does not revoke on DECRST leaving the alternate screen', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.seedOwner('shell')
      const generation = scanner.generation

      scanner.scan(LEAVE_ALT)

      expect(scanner.owner).toBe('shell')
      expect(scanner.generation).toBe(generation)
    })
  })

  describe('inert input', () => {
    it('ignores plain and colored output', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.seedOwner('shell')
      const generation = scanner.generation

      expect(scanner.scan('hello world\r\n')).toEqual({})
      expect(scanner.scan('\x1b[31mred\x1b[0m')).toEqual({})
      expect(scanner.owner).toBe('shell')
      expect(scanner.generation).toBe(generation)
    })

    it('leaves ownership intact across our own dead-TUI reset', () => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.seedOwner('shell')
      const generation = scanner.generation

      scanner.scan(POST_REPLAY_DEAD_TUI_RESET)

      expect(scanner.owner).toBe('shell')
      expect(scanner.generation).toBe(generation)
      expect(scanner.isAlternateScreenActive).toBe(false)
    })

    it('drops an oversized carried tail instead of growing without bound', () => {
      const scanner = new TerminalShellLifecycleScanner()

      expect(scanner.scan(`\x1b]133;${'x'.repeat(5000)}`)).toEqual({})
      expect(scanner.scan('\x07')).toEqual({})
    })
  })
})

describe('unclean trigger arming', () => {
  it('fires once per alternate-screen occupancy and re-arms only on a fresh entry', () => {
    const scanner = new TerminalShellLifecycleScanner()

    expect(scanner.scan('\x1b[?1049hTUI\x1b]133;D;137\x07').uncleanDeathTriggerEnd).toBeDefined()
    // Refuted path: no reset scanned, alt still active — a later prompt's D must not re-trigger.
    const second = scanner.scan('\x1b]133;C\x07ls\r\n\x1b]133;D;0\x07')
    expect(second.uncleanDeathTriggerEnd).toBeUndefined()
    expect(second.cleanExitCandidate).toBeUndefined()
    expect(scanner.isAlternateScreenActive).toBe(true)

    expect(
      scanner.scan('\x1b]133;C\x07\x1b[?1049hAGAIN\x1b]133;D;9\x07').uncleanDeathTriggerEnd
    ).toBeDefined()
  })
})
