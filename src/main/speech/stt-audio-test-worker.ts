import { EventEmitter } from 'node:events'

export class SttAudioTestWorker extends EventEmitter {
  static instances: SttAudioTestWorker[] = []
  messages: { type: string; byteEnd?: number; frameEnd?: number; samples?: Float32Array }[] = []
  throwNext = false
  terminated = false
  pendingTermination: Promise<number> | null = null
  emitStopped = false
  constructor() {
    super()
    SttAudioTestWorker.instances.push(this)
  }
  postMessage(message: { type: string }, transfer: Transferable[] = []) {
    if (this.throwNext) {
      this.throwNext = false
      throw new Error('post failed')
    }
    this.messages.push(structuredClone(message, { transfer }))
    if (message.type === 'init') {
      queueMicrotask(() => this.emit('message', { type: 'ready' }))
    }
    if (message.type === 'stop' && this.emitStopped) {
      queueMicrotask(() => this.emit('message', { type: 'stopped' }))
    }
  }
  terminate() {
    this.terminated = true
    if (this.pendingTermination) {
      return this.pendingTermination
    }
    this.emit('exit', 1)
    return Promise.resolve(1)
  }
  ack(index: number) {
    const frame = this.messages.filter((message) => message.type === 'feed')[index]
    if (!frame) {
      throw new Error('Missing admitted frame')
    }
    this.emit('message', {
      type: 'audio-consumed',
      byteEnd: frame.byteEnd,
      frameEnd: frame.frameEnd
    })
  }
}
