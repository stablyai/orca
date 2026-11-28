/**
 * Issue #8726 — Tasks upstream/origin problems on forks (cluster A + count cache).
 *
 * A. `auto` routes PRs to origin while issues use upstream-first heuristic:
 *    resolvePrWorkItemSource only prefers upstream when preference === 'upstream';
 *    auto/origin/undefined all collapse to originCandidate.
 *    resolveIssueSource('auto') uses getIssueOwnerRepo (upstream-first).
 *
 * B/G. countWorkItems always uses `gh api --cache 120s` with no noCache arg,
 *    so source flips can serve stale totals for up to two minutes.
 *
 * Existing listWorkItems tests already assert "upstream issues + origin PRs".
 * This file pins the pure routing + count-cache contracts called out in #8726.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/github/repro-8726-fork-pr-auto-origin.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const clientSource = readFileSync(join(__dirname, 'client.ts'), 'utf8')
const identitySource = readFileSync(join(__dirname, 'github-repository-identity.ts'), 'utf8')

/** Pure mirror of resolvePrWorkItemSource selection (client.ts). */
function resolvePrSource(
  preference: 'auto' | 'origin' | 'upstream' | undefined,
  origin: { owner: string; repo: string } | null,
  upstream: { owner: string; repo: string } | null
): { owner: string; repo: string } | null {
  return preference === 'upstream' ? (upstream ?? origin) : origin
}

describe('#8726 Tasks fork PR auto routes to origin (not upstream)', () => {
  it('pins resolvePrWorkItemSource: only explicit upstream leaves origin', () => {
    expect(clientSource).toMatch(
      /preference === 'upstream' \? \(upstreamCandidate \?\? originCandidate\) : originCandidate/
    )
    // Function is used from listWorkItems / countWorkItems
    expect(clientSource).toMatch(/resolvePrWorkItemSource\(/)
  })

  it('auto / undefined / origin all select the fork (origin) when upstream exists', () => {
    const origin = { owner: 'fork-user', repo: 'orca' }
    const upstream = { owner: 'stablyai', repo: 'orca' }
    expect(resolvePrSource('auto', origin, upstream)).toEqual(origin)
    expect(resolvePrSource(undefined, origin, upstream)).toEqual(origin)
    expect(resolvePrSource('origin', origin, upstream)).toEqual(origin)
    expect(resolvePrSource('upstream', origin, upstream)).toEqual(upstream)
  })

  it('issues auto path is upstream-first (contradicts PR auto pill)', () => {
    // getIssueOwnerRepo: upstream ?? origin
    expect(identitySource).toMatch(
      /export async function getIssueOwnerRepo[\s\S]*?const upstream = await getOwnerRepoForRemote[\s\S]*?if \(upstream\) \{\s*return upstream/s
    )
    // resolveIssueSource auto falls through to getIssueOwnerRepo
    expect(identitySource).toMatch(
      /export async function resolveIssueSource[\s\S]*?return \{\s*source: await getIssueOwnerRepo/s
    )
  })

  it('countWorkItems always passes gh api --cache 120s (no bypass on source flip)', () => {
    // Extract just countWorkItemsForQuery body — hardcodes cache, no noCache param
    const forQuery = clientSource.match(/async function countWorkItemsForQuery\([\s\S]*?\n\}/)?.[0]
    expect(forQuery).toBeTruthy()
    expect(forQuery).toMatch(/'--cache',\s*'120s'/)
    expect(forQuery).not.toMatch(/noCache/)

    // Public countWorkItems has no noCache argument in its parameter list
    const publicSig = clientSource.match(
      /export async function countWorkItems\(\s*repoPath: string,\s*query\?: string,\s*preference\?: IssueSourcePreference,\s*connectionId\?: string \| null,\s*localGitOptions: LocalGitExecOptions = \{\}\s*\)/
    )
    expect(publicSig).toBeTruthy()
  })
})
