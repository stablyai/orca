import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostedModuleGraph, hostedRoot, mobileRoot } from './hosted-module-graph.test-support'

const HOSTED_SESSION_ROUTE = join(hostedRoot, 'h', '[hostId]', 'session', '[worktreeId].tsx')

// Native-only entry points: on the hosted page these either throw or silently do nothing.
const BANNED_IN_HOSTED_BUNDLE = ['Clipboard.setStringAsync', "router.push('/terminal-settings')"]
const BANNED_IN_SESSION_ROUTE = [
  ...BANNED_IN_HOSTED_BUNDLE,
  'Linking.openURL',
  "/transport/host-store'"
]

describe('hosted route native API census', () => {
  it('keeps native-only APIs out of every module the hosted session route reaches', () => {
    const graph = hostedModuleGraph([HOSTED_SESSION_ROUTE])

    // Presence precondition: the walk must actually reach the session screen's own modules.
    expect(graph.length).toBeGreaterThan(500)
    expect(graph.map((path) => relative(mobileRoot, path))).toEqual(
      expect.arrayContaining([
        join('app', 'h', '[hostId]', 'session', '[worktreeId].tsx'),
        join('src', 'session', 'MobileTerminalInputActions.tsx')
      ])
    )
    expect(offenders(graph, BANNED_IN_SESSION_ROUTE)).toEqual([])
  })

  it('keeps native-only APIs out of every module any hosted route reaches', () => {
    const graph = hostedModuleGraph()

    expect(graph.length).toBeGreaterThan(500)
    // AsyncStorage is deliberately not censused: it is reachable today through the shared
    // storage and transport modules, and on web it resolves to localStorage.
    expect(offenders(graph, BANNED_IN_HOSTED_BUNDLE)).toEqual([])
  })
})

function offenders(graph: string[], banned: string[]): string[] {
  const found: string[] = []
  for (const modulePath of graph) {
    readFileSync(modulePath, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (banned.some((pattern) => line.includes(pattern))) {
          found.push(`${relative(mobileRoot, modulePath)}:${index + 1}`)
        }
      })
  }
  return found
}
