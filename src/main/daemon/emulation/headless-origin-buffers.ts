import type { Terminal } from '@xterm/headless'
import {
  originTerminalCore,
  type OriginBuffer,
  type OriginBufferLine,
  type OriginLineList
} from './headless-content-origin-lines'

/** Installation is per emulator instance, including rows constructed directly during resize. */
export class HeadlessOriginBuffers {
  private readonly buffers = new WeakSet<OriginBuffer>()
  private readonly lists = new WeakSet<OriginLineList>()
  constructor(
    private readonly terminal: Terminal,
    private readonly attachLine: (line: OriginBufferLine) => OriginBufferLine,
    private readonly changed: () => void,
    private readonly beforeChange: () => void,
    private readonly nativeFactory: (
      buffer: OriginBuffer,
      factory: OriginBuffer['getBlankLine']
    ) => boolean
  ) {
    const core = originTerminalCore(terminal)
    if (core && typeof core.reset === 'function') {
      const reset = core.reset
      core.reset = (...args) => {
        this.beforeChange()
        reset.apply(core, args)
        this.attach()
      }
    }
    this.attach()
  }

  attach(): void {
    const core = originTerminalCore(this.terminal)
    if (!core?.buffers) {
      return
    }
    for (const buffer of [core.buffers.normal, core.buffers.alt]) {
      if (!this.buffers.has(buffer)) {
        this.buffers.add(buffer)
        const blank = buffer.getBlankLine
        buffer.getBlankLine = (...args) => {
          if (!this.nativeFactory(buffer, blank)) {
            this.beforeChange()
          }
          return this.attachLine(blank.apply(buffer, args))
        }
        const clear = buffer.clear
        buffer.clear = (...args) => {
          this.beforeChange()
          clear.apply(buffer, args)
          this.attachList(buffer.lines)
        }
      }
      this.attachList(buffer.lines)
    }
  }

  private beforeInsert(list: OriginLineList, count: number): void {
    const capacity = list.maxLength
    if (capacity === undefined || !Number.isFinite(capacity) || list.length + count > capacity) {
      this.beforeChange()
    }
  }

  private attachList(list: OriginLineList): void {
    if (this.lists.has(list)) {
      return
    }
    this.lists.add(list)
    const get = list.get
    const set = list.set
    list.set = (index, line) => {
      this.beforeChange()
      set.call(list, index, this.attachLine(line))
      this.changed()
    }
    const push = list.push
    list.push = (line) => {
      this.beforeInsert(list, 1)
      push.call(list, this.attachLine(line))
      this.changed()
    }
    const splice = list.splice
    list.splice = (start, count, ...lines) => {
      if (count) {
        this.beforeChange()
      } else {
        this.beforeInsert(list, lines.length)
      }
      splice.call(list, start, count, ...lines.map((line) => this.attachLine(line)))
      this.changed()
    }
    const shift = list.shiftElements
    list.shiftElements = (start, count, offset) => {
      this.beforeChange()
      shift.call(list, start, count, offset)
      this.changed()
    }
    const trim = list.trimStart
    list.trimStart = (count) => {
      this.beforeChange()
      trim.call(list, count)
      this.changed()
    }
    const pop = list.pop
    list.pop = () => {
      this.beforeChange()
      const result = pop.call(list)
      this.changed()
      return result
    }
    const recycle = list.recycle
    list.recycle = () => {
      this.beforeChange()
      this.changed()
      return this.attachLine(recycle.call(list))
    }
    const length = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(list), 'length')
    if (length?.get && length.set) {
      Object.defineProperty(list, 'length', {
        configurable: true,
        get: () => length.get!.call(list),
        set: (value: number) => {
          this.beforeChange()
          length.set!.call(list, value)
          this.changed()
        }
      })
    }
    for (let i = 0; i < list.length; i++) {
      const line = get.call(list, i)
      if (line) {
        this.attachLine(line)
      }
    }
  }
}
