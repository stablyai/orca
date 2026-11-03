import type { Stream } from './mobile-terminal-stream-record'

type ApplicationCost = { bytes: number; frames: number; outputBytes?: number; receipt: boolean }

export function createMobileTerminalEventApplication(owner: {
  isCurrent: (id: number, stream: Stream) => boolean
  release: (stream: Stream, bytes: number, frames: number) => void
  acknowledge: (id: number, bytes: number) => boolean
  fail: (id: number, message: string) => void
}) {
  return (id: number, stream: Stream, event: unknown, cost: ApplicationCost): unknown => {
    try {
      const applied = stream.listener(event)
      if (cost.receipt && !(applied instanceof Promise)) {
        owner.fail(id, 'Terminal application receipt unavailable')
        return
      }
      void Promise.resolve(applied).then(
        () => {
          if (!owner.isCurrent(id, stream)) {
            return
          }
          owner.release(stream, cost.bytes, cost.frames)
          if (cost.outputBytes && !owner.acknowledge(id, cost.outputBytes)) {
            owner.fail(id, 'Terminal acknowledgement failed')
          }
        },
        () => {
          if (owner.isCurrent(id, stream)) {
            owner.fail(id, 'Terminal application failed')
          }
        }
      )
      return applied
    } catch {
      owner.fail(id, 'Terminal application failed')
    }
  }
}
