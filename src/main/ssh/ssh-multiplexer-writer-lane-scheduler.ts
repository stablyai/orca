import type { MultiplexerWriterLane } from './ssh-multiplexer-transport-writer'

const CONTROL_WRITES_BEFORE_ORDINARY = 4

type LaneQueue<T> = {
  entries: T[]
  head: number
}

function createLaneQueue<T>(): LaneQueue<T> {
  return { entries: [], head: 0 }
}

function hasEntries<T>(queue: LaneQueue<T>): boolean {
  return queue.head < queue.entries.length
}

function shift<T>(queue: LaneQueue<T>): T | undefined {
  const entry = queue.entries[queue.head]
  if (entry === undefined) {
    return undefined
  }
  queue.head += 1
  if (queue.head === queue.entries.length) {
    queue.entries.length = 0
    queue.head = 0
  }
  return entry
}

function clear<T>(queue: LaneQueue<T>): T[] {
  const entries = queue.entries.slice(queue.head)
  queue.entries.length = 0
  queue.head = 0
  return entries
}

export class SshMultiplexerWriterLaneScheduler<T extends object> {
  private readonly ordinary = createLaneQueue<T>()
  private readonly control = createLaneQueue<T>()
  private readonly liveness = createLaneQueue<T>()
  private controlWritesSinceOrdinary = 0

  enqueue(entry: T, lane: MultiplexerWriterLane): void {
    this[lane].entries.push(entry)
  }

  select(): T | undefined {
    const liveness = shift(this.liveness)
    if (liveness) {
      return liveness
    }
    if (
      hasEntries(this.control) &&
      (!hasEntries(this.ordinary) ||
        this.controlWritesSinceOrdinary < CONTROL_WRITES_BEFORE_ORDINARY)
    ) {
      this.controlWritesSinceOrdinary += 1
      return shift(this.control)
    }
    const ordinary = shift(this.ordinary)
    if (ordinary) {
      this.controlWritesSinceOrdinary = 0
      return ordinary
    }
    return shift(this.control)
  }

  clear(): T[] {
    this.controlWritesSinceOrdinary = 0
    return [...clear(this.liveness), ...clear(this.control), ...clear(this.ordinary)]
  }
}
