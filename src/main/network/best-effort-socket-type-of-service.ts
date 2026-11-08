import { Socket } from 'node:net'

/** undici sets TOS before each HTTP/1 write, outside any fetch promise; a macOS socket the peer already reset fails it with EINVAL and kills main (STA-14317). Node already treats it as best effort on Windows. */
export function installBestEffortSocketTypeOfService(): void {
  const setTypeOfService = Socket.prototype.setTypeOfService
  if (typeof setTypeOfService !== 'function') {
    return
  }
  Socket.prototype.setTypeOfService = function (this: Socket, tos: number): Socket {
    try {
      return setTypeOfService.call(this, tos)
    } catch (error) {
      // Argument validation errors carry no syscall and still throw.
      if (
        !(error instanceof Error) ||
        !('syscall' in error) ||
        error.syscall !== 'setTypeOfService'
      ) {
        throw error
      }
      return this
    }
  }
}
