import { routeNativeChatHref } from '../../../src/shared/native-chat-href-routing'

export type MarkdownHrefRoute =
  | { kind: 'web'; url: string }
  | { kind: 'file'; pathText: string }
  | { kind: 'none' }

function withLineSuffix(pathText: string, line: number | null): string {
  return line === null ? pathText : `${pathText}:${line}`
}

export function routeMarkdownHref(href: string): MarkdownHrefRoute {
  const route = routeNativeChatHref(href)
  if (route.kind !== 'file') {
    return route
  }
  return { kind: 'file', pathText: withLineSuffix(route.pathText, route.line) }
}
