import { describe, expect, it } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import {
  buildMobileProjectSectionCatalog,
  type MobileProjectSectionCatalog
} from '../../../src/shared/mobile-project-sections-contract'
import {
  buildSidebarProjectCatalog,
  type PairedServerCatalog
} from '../../../src/shared/sidebar-list/sidebar-project-catalog'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import type { Repo } from '../../../src/shared/repo-types'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { resolveMobileLinkedWorkItemPromptTemplate } from './linked-work-item-prompt-template'

const globalSettings = { linkedWorkItemPromptTemplate: '{{url}} /global' }

function surface(hostId: ExecutionHostId, template: string | undefined, repoId = hostId) {
  const repo: Repo = {
    id: repoId,
    displayName: 'Project',
    badgeColor: '#737373',
    addedAt: 1,
    path: `/repos/${hostId}`,
    upstream: { owner: 'acme', repo: 'app' },
    executionHostId: hostId
  }
  const derived = projectHostSetupProjectionFromRepos([repo])
  return {
    hostId,
    repos: [repo],
    projectGroups: [],
    projection: {
      ...derived,
      projects: derived.projects.map((project) => ({
        ...project,
        linkedWorkItemPromptTemplate: template
      }))
    }
  } satisfies PairedServerCatalog
}

function clientServing(catalog: MobileProjectSectionCatalog | null) {
  return {
    ...createFakeRpcClient(),
    sendRequest: async (method: string) => {
      expect(method).toBe('mobileRelay.projectSections')
      return { id: '1', ok: true as const, result: { catalog }, _meta: { runtimeId: 'r' } }
    }
  }
}

describe('mobile canonical linked work item prompt settings', () => {
  it.each(['{{url}} /local', undefined])(
    'uses paired local configuration %s across local and runtime setups',
    async (template) => {
      const local = surface('local', template)
      const remote = surface('runtime:server', '{{url}} /stale-runtime')
      const catalog = buildSidebarProjectCatalog(
        {
          repos: local.repos,
          projects: local.projection.projects,
          setups: local.projection.setups,
          projectGroups: []
        },
        [remote],
        undefined
      )
      expect(catalog.projects[0]?.linkedWorkItemPromptTemplate).toBe(template ?? null)
      expect(
        await resolveMobileLinkedWorkItemPromptTemplate(
          clientServing(catalog),
          remote.repos[0]!,
          globalSettings
        )
      ).toBe(template ?? '{{url}} /global')
    }
  )

  it.each([false, true])(
    'uses runtime A configuration when launching on B regardless of catalog order %s',
    async (reverse) => {
      const owner = surface('runtime:a', '{{url}} /owner-a')
      const target = surface('runtime:b', '{{url}} /stale-b')
      const servers = reverse ? [target, owner] : [owner, target]
      const catalog = buildSidebarProjectCatalog(
        { repos: [], projects: [], setups: [], projectGroups: [] },
        servers,
        undefined
      )
      expect(
        await resolveMobileLinkedWorkItemPromptTemplate(
          clientServing(catalog),
          target.repos[0]!,
          globalSettings
        )
      ).toBe('{{url}} /owner-a')
    }
  )

  it('qualifies duplicate repo IDs by execution host', async () => {
    const local = surface('local', '{{url}} /local', 'duplicate')
    const remote = surface('runtime:server', '{{url}} /remote', 'duplicate')
    const remoteProjectId = 'other-project'
    const catalog = buildMobileProjectSectionCatalog(
      [...local.repos, ...remote.repos],
      {
        projects: [
          ...local.projection.projects,
          ...remote.projection.projects.map((project) => ({ ...project, id: remoteProjectId }))
        ],
        setups: [
          ...local.projection.setups,
          ...remote.projection.setups.map((setup) => ({ ...setup, projectId: remoteProjectId }))
        ]
      },
      'manual'
    )
    expect(
      await resolveMobileLinkedWorkItemPromptTemplate(
        clientServing(catalog),
        remote.repos[0]!,
        globalSettings
      )
    ).toBe('{{url}} /remote')
  })

  it('inherits global/default on old catalog payloads without a template field', async () => {
    const local = surface('local', '{{url}} /not-in-old-payload')
    const catalog = buildMobileProjectSectionCatalog(local.repos, local.projection, 'manual')
    for (const project of catalog.projects) {
      delete project.linkedWorkItemPromptTemplate
    }
    expect(
      await resolveMobileLinkedWorkItemPromptTemplate(
        clientServing(catalog),
        local.repos[0]!,
        globalSettings
      )
    ).toBe('{{url}} /global')
    expect(
      await resolveMobileLinkedWorkItemPromptTemplate(clientServing(catalog), local.repos[0]!, {})
    ).toBeUndefined()
  })

  it('retains host defaults when an older host cannot serve the catalog', async () => {
    const client = {
      ...createFakeRpcClient(),
      sendRequest: async () => ({
        id: '1',
        ok: false as const,
        error: { code: 'METHOD_NOT_FOUND', message: 'Unknown method' },
        _meta: { runtimeId: 'r' }
      })
    }
    expect(
      await resolveMobileLinkedWorkItemPromptTemplate(client, { id: 'repo-1' }, globalSettings)
    ).toBe('{{url}} /global')
    expect(
      await resolveMobileLinkedWorkItemPromptTemplate(client, { id: 'repo-1' }, {})
    ).toBeUndefined()
    expect(
      await resolveMobileLinkedWorkItemPromptTemplate(
        clientServing(null),
        { id: 'repo-1' },
        globalSettings
      )
    ).toBe('{{url}} /global')
  })
})
