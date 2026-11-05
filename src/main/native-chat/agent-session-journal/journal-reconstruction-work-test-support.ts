import { vi } from 'vitest'
import { Worker } from 'node:worker_threads'
type ReconstructionOwner =
  | typeof Map.prototype
  | typeof Set.prototype
  | typeof JSON
  | typeof Reflect
  | Iterator<unknown>

export const reconstructionWork = { visit: (_count = 1): void => {} }

/** Count host visits/copies, comparisons, decoding and index steps, including hidden final loops. */
export async function countReconstructionWork<T>(
  run: () => Promise<T>,
  between: () => void
): Promise<{
  result: T
  maximum: number
  yields: number
  total: number
  site: string
  uploads: number
  maxUploadPackets: number
}> {
  let current = 0,
    maximum = 0,
    yields = 0,
    total = 0
  let site = ''
  let uploads = 0,
    maxUploadPackets = 0
  const charge = (count = 1): void => {
    current += count
    total += count
    if (current > 65_536 && !site) {
      site = new Error('ordinary work crossed budget').stack ?? ''
    }
  }
  reconstructionWork.visit = charge
  const restore: (() => void)[] = []
  const instrument = (
    target: ReconstructionOwner,
    name: string,
    count: (args: unknown[], result: unknown) => number
  ): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name)
    const original: unknown = descriptor?.value
    if (!descriptor || typeof original !== 'function') {
      throw new Error(`missing operation ${name}`)
    }
    Object.defineProperty(target, name, {
      ...descriptor,
      value: function (this: unknown, ...args: unknown[]) {
        const result: unknown = original.apply(this, args)
        charge(count(args, result))
        return result
      }
    })
    restore.push(() => Object.defineProperty(target, name, descriptor))
  }
  const one = () => 1
  for (const name of ['get', 'set', 'has', 'delete']) {
    instrument(Map.prototype, name, one)
  }
  for (const name of ['add', 'has', 'delete']) {
    instrument(Set.prototype, name, one)
  }
  for (const iterator of [new Map().values(), new Set().values(), [][Symbol.iterator]()]) {
    instrument(Object.getPrototypeOf(iterator), 'next', one)
  }
  instrument(JSON, 'parse', one)
  instrument(JSON, 'stringify', one)
  instrument(Reflect, 'ownKeys', (_args, result) => (Array.isArray(result) ? result.length : 0))
  for (const name of ['slice', 'map', 'filter', 'flatMap']) {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, name)!
    const original: unknown = descriptor.value
    if (typeof original !== 'function') {
      throw new Error(`missing array ${name}`)
    }
    Object.defineProperty(Array.prototype, name, {
      ...descriptor,
      value: function (this: unknown[], ...args: unknown[]) {
        charge(this.length)
        return original.apply(this, args)
      }
    })
    restore.push(() => Object.defineProperty(Array.prototype, name, descriptor))
  }
  const immediate = setImmediate
  const finishPiece = (): void => {
    maximum = Math.max(maximum, current)
    current = 0
    yields++
    between()
  }
  const emit = Worker.prototype.emit
  const post = Worker.prototype.postMessage
  const upload = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    message,
    transferList
  ) {
    if (typeof message === 'object' && message && 'command' in message) {
      const command: unknown = message.command
      if (
        typeof command === 'object' &&
        command &&
        'type' in command &&
        command.type === 'upload' &&
        'packets' in command &&
        Array.isArray(command.packets)
      ) {
        uploads++
        maxUploadPackets = Math.max(maxUploadPackets, command.packets.length)
      }
    }
    return post.call(this, message, transferList)
  })
  const native = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
    this: Worker,
    event,
    ...args
  ) {
    if (event === 'message') {
      finishPiece()
    }
    return emit.call(this, event, ...args)
  })
  const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback, ...args) =>
    immediate(() => {
      finishPiece()
      callback(...args)
    })
  )
  try {
    const result = await run()
    maximum = Math.max(maximum, current)
    return { result, maximum, yields, total, site, uploads, maxUploadPackets }
  } finally {
    reconstructionWork.visit = () => {}
    spy.mockRestore()
    native.mockRestore()
    upload.mockRestore()
    for (const undo of restore.toReversed()) {
      undo()
    }
  }
}
