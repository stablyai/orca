import { Redirect, useLocalSearchParams } from 'expo-router'

/**
 * Web sibling for the hybrid shell route. This page is what that route's WebView displays, so the
 * shell has nowhere to nest here; the native file also reaches OrcaMobileWebShellView, whose
 * module calls requireNativeViewManager at import and throws in a browser, and one throwing route
 * module takes the whole bundle down because the manifest imports them all.
 */
export default function MobileWebShellRoute() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  return <Redirect href={`/h/${hostId ?? ''}`} />
}
