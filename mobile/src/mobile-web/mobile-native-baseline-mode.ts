const NATIVE_BASELINE_FLAG = '1'
const NATIVE_ARCHITECTURE = 'native'
const HYBRID_ARCHITECTURE = 'hybrid'

export function mobileNativeBaselineMode(args: {
  developmentBuild: boolean
  requested: string | undefined
  architecture?: string | undefined
}): boolean {
  // The E2E baseline override remains development-only so a production build
  // cannot accidentally re-enable the retired workspace route.
  if (args.developmentBuild && args.requested === NATIVE_BASELINE_FLAG) {
    return true
  }
  if (args.architecture === NATIVE_ARCHITECTURE) {
    return true
  }
  if (args.architecture === HYBRID_ARCHITECTURE) {
    return false
  }
  // Development builds keep the existing hybrid test surface; release builds
  // are native until a dedicated hybrid artifact opts in explicitly.
  return !args.developmentBuild
}

// Whether `/hybrid` itself is a destination. A development E2E build keeps it reachable so the
// native baselines and the hosted journeys run against one Metro bundle; a native build or a
// release default retires it.
export function mobileHybridRouteRetired(args: {
  developmentBuild: boolean
  architecture?: string | undefined
}): boolean {
  if (args.architecture === NATIVE_ARCHITECTURE) {
    return true
  }
  if (args.architecture === HYBRID_ARCHITECTURE) {
    return false
  }
  return !args.developmentBuild
}

export const MOBILE_NATIVE_BASELINE_MODE = mobileNativeBaselineMode({
  developmentBuild: typeof __DEV__ !== 'undefined' && __DEV__,
  requested: process.env.EXPO_PUBLIC_ORCA_E2E_MOBILE_NATIVE_BASELINE,
  architecture: process.env.EXPO_PUBLIC_ORCA_MOBILE_ARCHITECTURE
})

export const MOBILE_HYBRID_ROUTE_RETIRED = mobileHybridRouteRetired({
  developmentBuild: typeof __DEV__ !== 'undefined' && __DEV__,
  architecture: process.env.EXPO_PUBLIC_ORCA_MOBILE_ARCHITECTURE
})
