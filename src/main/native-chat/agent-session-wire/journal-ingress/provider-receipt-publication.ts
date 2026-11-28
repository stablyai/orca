export type BeginProviderReceipt = () => ((isPending: () => boolean) => void) | undefined

/** Optional delivery status cannot fail the provider frame or send it accompanies. */
export function withProviderReceipt<T>(publish: () => T): T | undefined {
  try {
    return publish()
  } catch {
    return undefined
  }
}
