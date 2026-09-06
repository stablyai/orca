export type MobileWebCachedBuildProbe = {
  hostEpoch: number
  promise: Promise<string | null>
  resolve: (buildId: string | null) => void
}

export function createMobileWebCachedBuildProbe(hostEpoch: number): MobileWebCachedBuildProbe {
  let resolvePromise: (buildId: string | null) => void = () => {}
  const promise = new Promise<string | null>((resolve) => {
    resolvePromise = resolve
  })
  return { hostEpoch, promise, resolve: resolvePromise }
}
