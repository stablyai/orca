import { useLocalSearchParams, usePathname } from 'expo-router'
import { mobileWebRouteQuery } from './mobile-web-route-query-cache'

export function useMobileWebRouteParams<
  T extends Record<string, string | string[] | undefined>
>(): T {
  const pathname = usePathname()
  const params = useLocalSearchParams() as T
  return { ...mobileWebRouteQuery(pathname), ...params } as T
}
