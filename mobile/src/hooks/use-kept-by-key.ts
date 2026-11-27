import { useState } from 'react'

/** The value from the render where `key` last changed: stands in for a value rebuilt each render that counts by `key`. */
export function useKeptByKey<T>(key: string, value: T): T {
  const [kept, setKept] = useState({ key, value })
  if (kept.key !== key) {
    setKept({ key, value })
    return value
  }
  return kept.value
}
