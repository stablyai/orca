import { createMobileE2EEOutboundMemoryBudget } from '../../../src/shared/mobile-e2ee-outbound-memory-budget'

export const mobileE2eeOutboundMemory = createMobileE2EEOutboundMemoryBudget({
  maxQueuedBytes: 64 * 1024 * 1024
})

export function registerMobileE2eeSocket(socket: {
  readonly bufferedAmount: number
  readonly readyState: number
  addEventListener?: (type: 'close', listener: () => void, options?: { once: boolean }) => void
}) {
  const source = mobileE2eeOutboundMemory.registerBufferedAmount(() => socket.bufferedAmount)
  socket.addEventListener?.('close', () => source?.release(), { once: true })
  return {
    canSend: (bytes: number) => source?.canSend(bytes) === true,
    dispose: () => {
      if (socket.bufferedAmount === 0 || socket.readyState === 3) {
        source?.release()
      }
    }
  }
}
