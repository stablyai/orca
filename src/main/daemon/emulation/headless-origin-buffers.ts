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
    private readonly changed: () => void
  ) {
    const core = originTerminalCore(terminal)
    if (core && typeof core.reset === 'function') {
      const reset = core.reset
      core.reset = (...args) => {
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
        buffer.getBlankLine = (...args) => this.attachLine(blank.apply(buffer, args))
        const clear = buffer.clear
        buffer.clear = (...args) => {
          clear.apply(buffer, args)
          this.attachList(buffer.lines)
        }
      }
      this.attachList(buffer.lines)
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
      set.call(list, index, this.attachLine(line))
      this.changed()
    }
    const push = list.push
    list.push = (line) => {
      push.call(list, this.attachLine(line))
      this.changed()
    }
    const splice = list.splice
    list.splice = (start, count, ...lines) => {
      splice.call(list, start, count, ...lines.map((line) => this.attachLine(line)))
      this.changed()
    }
    const shift = list.shiftElements
    list.shiftElements = (start, count, offset) => {
      shift.call(list, start, count, offset)
      this.changed()
    }
    const trim = list.trimStart
    list.trimStart = (count) => {
      trim.call(list, count)
      this.changed()
    }
    const pop = list.pop
    list.pop = () => {
      const result = pop.call(list)
      this.changed()
      return result
    }
    const recycle = list.recycle
    list.recycle = () => {
      this.changed()
      return this.attachLine(recycle.call(list))
    }
    const length = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(list), 'length')
    if (length?.get && length.set) {
      Object.defineProperty(list, 'length', {
        configurable: true,
        get: () => length.get!.call(list),
        set: (value: number) => {
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
