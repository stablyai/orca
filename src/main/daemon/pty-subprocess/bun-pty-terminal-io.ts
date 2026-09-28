import type { BunTerminal } from './bun-pty-process-contract'

export function createBunPtyTerminalIo(
  terminal: BunTerminal,
  dimensions: { cols: number; rows: number },
  isExited: () => boolean,
  terminate: () => void
) {
  let cols = dimensions.cols
  let rows = dimensions.rows
  let state: 'active' | 'failed' | 'retiring' = 'active'

  const retire = (): void => {
    try {
      terminate()
      state = 'retiring'
    } catch (error) {
      console.warn('[daemon/pty] Failed to retire PTY:', error)
    }
  }
  const canUseTerminal = (): boolean => {
    if (isExited()) {
      return false
    }
    if (state === 'failed') {
      retire()
    }
    return state === 'active' && !terminal.closed
  }
  const fail = (error: unknown): void => {
    console.warn('[daemon/pty] Native terminal I/O failed; retiring PTY:', error)
    state = 'failed'
    retire()
  }

  return {
    get cols() {
      return cols
    },
    get rows() {
      return rows
    },
    write(data: string | Buffer) {
      if (!canUseTerminal()) {
        return
      }
      try {
        terminal.write(data)
      } catch (error) {
        // Bun buffers backpressure internally; replaying a failed write can duplicate its prefix.
        fail(error)
      }
    },
    resize(nextCols: number, nextRows: number) {
      if (!canUseTerminal()) {
        return
      }
      try {
        terminal.resize(nextCols, nextRows)
        cols = nextCols
        rows = nextRows
      } catch (error) {
        if (terminal.closed) {
          fail(error)
        } else {
          console.warn('[daemon/pty] Native terminal resize failed:', error)
        }
      }
    }
  }
}
