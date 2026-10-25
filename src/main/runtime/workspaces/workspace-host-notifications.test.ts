import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeStore } from '../runtime-store-contract'
import { partialRuntimeStore } from '../runtime-store-partial-fixture'

function catalogEventsFor(repo: Repo): RuntimeClientEvent[] {
  const store: Pick<RuntimeStore, 'getRepos'> = { getRepos: () => [repo] }
  const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
  const events: RuntimeClientEvent[] = []
  runtime.onClientEvent((event) => events.push(event))
  runtime.notifyWorktreeCatalogChangedForRemoteClients(repo.id)
  return events.filter((event) => event.type === 'worktreesChanged')
}

const baseRepo: Repo = { id: 'r', path: '/r', displayName: 'r', badgeColor: 'blue', addedAt: 1 }

describe('notifyWorktreeCatalogChangedForRemoteClients', () => {
  it('tells remote clients about a local repo', () => {
    expect(catalogEventsFor(baseRepo)).toHaveLength(1)
  })

  it('skips an SSH repo named only by its execution host', () => {
    expect(catalogEventsFor({ ...baseRepo, executionHostId: 'ssh:target-1' })).toHaveLength(0)
  })

  it('skips an SSH repo named by its legacy connection id', () => {
    expect(catalogEventsFor({ ...baseRepo, connectionId: 'target-1' })).toHaveLength(0)
  })
})
