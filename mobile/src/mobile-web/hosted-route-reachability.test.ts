import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hostedModuleGraph,
  hostedRoot,
  listRoutes,
  mobileRoot,
  nativeRoot
} from './hosted-module-graph.test-support'

describe('hosted page route reachability', () => {
  const hostedRoutes = listRoutes(hostedRoot)
  const nativeOnlyRoutes = listRoutes(nativeRoot).filter((route) => !hostedRoutes.includes(route))

  it('knows which native routes the hosted page does not serve', () => {
    expect(nativeOnlyRoutes).toContain('/connection-log')
    expect(nativeOnlyRoutes).toContain('/pair-scan')
    expect(hostedRoutes).toContain('/h/[hostId]')
  })

  it('never navigates a hosted screen to a route only the native shell has', () => {
    const nativeOnlyTargets = new RegExp(
      `['"](${nativeOnlyRoutes.map(escapeForPattern).join('|')})['"]`
    )
    const graph = hostedModuleGraph()
    // Presence precondition: a broken walk reports green over an empty universe.
    expect(graph.length).toBeGreaterThan(500)
    const offenders: string[] = []
    for (const modulePath of graph) {
      readFileSync(modulePath, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (nativeOnlyTargets.test(line)) {
            offenders.push(`${relative(mobileRoot, modulePath)}:${index + 1}`)
          }
        })
    }
    expect(offenders).toEqual([])
  })
})

function escapeForPattern(route: string): string {
  return route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
