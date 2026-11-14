import type { AiVaultRowObserver, AiVaultScanRows } from '../../../shared/ai-vault-scan-rows'

type RowInterestOwner = AiVaultRowObserver | ((rows: AiVaultScanRows) => void)
type Interest = {
  observed: () => boolean
  subscribe: (changed: () => void) => () => void
}
const interests = new WeakMap<RowInterestOwner, Interest>()

export function rowsAreObserved(observer?: RowInterestOwner): boolean {
  return observer !== undefined && (interests.get(observer)?.observed() ?? true)
}

export function watchRowInterest(observer: RowInterestOwner, changed: () => void): () => void {
  return interests.get(observer)?.subscribe(changed) ?? (() => undefined)
}

export function setRowInterest(observer: RowInterestOwner, interest: Interest): void {
  interests.set(observer, interest)
}

export function forwardRowInterest(target: RowInterestOwner, source: RowInterestOwner): void {
  const interest = interests.get(source)
  if (interest) {
    interests.set(target, interest)
  }
}
