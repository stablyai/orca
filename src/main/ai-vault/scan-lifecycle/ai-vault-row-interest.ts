type Interest = {
  observed: () => boolean
  subscribe: (changed: () => void) => () => void
}
const interests = new WeakMap<object, Interest>()

export function rowsAreObserved(observer?: object): boolean {
  return observer !== undefined && (interests.get(observer)?.observed() ?? true)
}

export function watchRowInterest(observer: object, changed: () => void): () => void {
  return interests.get(observer)?.subscribe(changed) ?? (() => undefined)
}

export function setRowInterest(observer: object, interest: Interest): void {
  interests.set(observer, interest)
}

export function forwardRowInterest(target: object, source: object): void {
  const interest = interests.get(source)
  if (interest) {
    interests.set(target, interest)
  }
}
