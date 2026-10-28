import { basename } from 'node:path'
import type { SkillDiscoverySource } from '../../shared/skills'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { stablePathId } from './skill-discovery-classification'

/** SSH repos this host cannot read, reported so the gap is visible instead of silent (#11466). */
export function buildRemoteRepoSkillSources(repos: readonly Repo[]): SkillDiscoverySource[] {
  const sources = new Map<string, SkillDiscoverySource>()
  for (const repo of repos) {
    const hostId = getRepoExecutionHostId(repo)
    // Why SSH only: a paired runtime's repos are scanned by that runtime when it is the focus.
    if (parseExecutionHostId(hostId)?.kind !== 'ssh') {
      continue
    }
    const id = `repo-remote-${stablePathId(`${hostId}\0${repo.path}`)}`
    sources.set(id, {
      id,
      label: `Repo ${basename(repo.path)}`,
      path: repo.path,
      sourceKind: 'repo',
      providers: ['agent-skills', 'claude'],
      owner: null,
      exists: false,
      skippedReason: 'remote-repo'
    })
  }
  return [...sources.values()]
}
