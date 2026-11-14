import { DispatchPresentationPriority } from './dispatch-presentation-priority'

/** One addressable deadline per eligible dispatch; removing its owner also removes its deadline. */
export class DispatchPresentationDeadlines extends DispatchPresentationPriority {
  *expired(now: number): Iterable<string> {
    let next = this.peek()
    while (next && next.priority < now) {
      this.delete(next.id)
      yield next.id
      next = this.peek()
    }
  }
}
