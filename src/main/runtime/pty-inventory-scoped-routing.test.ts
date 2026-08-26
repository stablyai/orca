import { describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import {
  LOCAL_WORKTREE_ID,
  RUNTIME_WORKTREE_ID,
  SSH_A_WORKTREE_ID,
  SSH_B_WORKTREE_ID,
  SSH_C_WORKTREE_ID,
  SSH_FOLDER,
  WSL_WORKTREE_ID,
  makeHarness,
  resolvedWorktree,
  type ProviderKey
} from './pty-inventory-scoped-routing-fixtures'

describe('scoped PTY inventory routing', () => {
  it('queries only the exact local, WSL-local, SSH, or folder owner and fans out only when unscoped', async () => {
    const harness = makeHarness()
    harness.sessions.local.push(
      { id: 'pty-local', cwd: '/local/project', worktreeId: LOCAL_WORKTREE_ID },
      {
        id: 'pty-wsl',
        cwd: '/mnt/c/work/project',
        worktreeId: WSL_WORKTREE_ID,
        wslDistro: 'Ubuntu'
      }
    )

    const local = await harness.runtime.listTerminals(`id:${LOCAL_WORKTREE_ID}`)
    expect(harness.providers.local).toHaveBeenCalledOnce()
    expect(harness.providers['box-a']).not.toHaveBeenCalled()
    expect(harness.providers['box-b']).not.toHaveBeenCalled()
    expect(harness.providers['box-c']).not.toHaveBeenCalled()
    expect(local.terminals.map((terminal) => terminal.ptyId)).toEqual(['pty-local'])

    harness.clearProviderCalls()
    const wsl = await harness.runtime.listTerminals(`id:${WSL_WORKTREE_ID}`)
    expect(harness.providers.local).toHaveBeenCalledOnce()
    expect(harness.listProcesses).toHaveBeenCalledWith(null, expect.any(Object))
    expect(wsl.terminals.map((terminal) => terminal.ptyId)).toEqual(['pty-wsl'])

    harness.clearProviderCalls()
    await harness.runtime.listTerminals(`id:${SSH_A_WORKTREE_ID}`)
    expect(harness.providers['box-a']).toHaveBeenCalledOnce()
    expect(harness.providers.local).not.toHaveBeenCalled()
    expect(harness.providers['box-b']).not.toHaveBeenCalled()
    expect(harness.providers['box-c']).not.toHaveBeenCalled()

    harness.clearProviderCalls()
    await harness.runtime.listTerminals(`id:${folderWorkspaceKey(SSH_FOLDER.id)}`)
    expect(harness.providers['box-b']).toHaveBeenCalledOnce()
    expect(harness.providers.local).not.toHaveBeenCalled()
    expect(harness.providers['box-a']).not.toHaveBeenCalled()
    expect(harness.providers['box-c']).not.toHaveBeenCalled()

    harness.clearProviderCalls()
    await harness.runtime.listMobileSessionTabs(`id:${SSH_C_WORKTREE_ID}`)
    expect(harness.providers['box-c']).toHaveBeenCalledOnce()
    expect(harness.providers.local).not.toHaveBeenCalled()
    expect(harness.providers['box-a']).not.toHaveBeenCalled()
    expect(harness.providers['box-b']).not.toHaveBeenCalled()

    harness.clearProviderCalls()
    await harness.runtime.listTerminals()
    expect(harness.listProcessesWithHostScope).toHaveBeenCalledOnce()
    expect(harness.providers.local).toHaveBeenCalledOnce()
    expect(harness.providers['box-a']).toHaveBeenCalledOnce()
    expect(harness.providers['box-b']).toHaveBeenCalledOnce()
    expect(harness.providers['box-c']).toHaveBeenCalledOnce()
  })

  it('keeps runtime-owned targets omitted without querying a local or SSH provider', async () => {
    const harness = makeHarness()

    const result = await harness.runtime.listTerminals(`id:${RUNTIME_WORKTREE_ID}`)

    expect(harness.listProcesses).not.toHaveBeenCalled()
    expect(harness.listProcessesWithHostScope).not.toHaveBeenCalled()
    expect(result.hostScope?.hostIds).toEqual([])
    expect(result.hostScope?.omittedHostIds).toContain('runtime:environment-1')
  })

  it('isolates provider failures and never retires a PTY from an unqueried or unavailable owner', async () => {
    const harness = makeHarness()
    const sshAPty = 'ssh:box-a@@pty-a'
    const sshBPty = 'ssh:box-b@@pty-b'
    const sshCPty = 'ssh:box-c@@pty-c'
    harness.sessions['box-a'].push({
      id: sshAPty,
      cwd: '/srv/a/project',
      worktreeId: SSH_A_WORKTREE_ID
    })
    harness.runtime.registerPty(sshAPty, SSH_A_WORKTREE_ID, 'box-a')
    harness.runtime.registerPty(sshCPty, SSH_C_WORKTREE_ID, 'box-c')
    harness.failures.add('box-c')

    const scoped = await harness.runtime.listTerminals(`id:${SSH_A_WORKTREE_ID}`)
    expect(scoped.terminals.map((terminal) => terminal.ptyId)).toContain(sshAPty)
    expect(harness.providers['box-a']).toHaveBeenCalledOnce()
    expect(harness.providers['box-c']).not.toHaveBeenCalled()

    harness.clearProviderCalls()
    await harness.runtime.listTerminals(`id:${LOCAL_WORKTREE_ID}`)
    expect(harness.internals.ptysById.get(sshCPty)?.connected).toBe(true)
    expect(harness.providers['box-c']).not.toHaveBeenCalled()

    harness.clearProviderCalls()
    await harness.runtime.listTerminals()
    expect(harness.providers['box-c']).toHaveBeenCalledOnce()
    expect(harness.internals.ptysById.get(sshCPty)?.connected).toBe(true)

    harness.clearProviderCalls()
    harness.runtime.registerPty(sshBPty, SSH_B_WORKTREE_ID, 'box-b')
    harness.failures.add('box-b')
    const unavailableOwner = await harness.runtime.listTerminals(`id:${SSH_B_WORKTREE_ID}`)
    expect(unavailableOwner.terminals.map((terminal) => terminal.ptyId)).toContain(sshBPty)
    expect(harness.providers['box-b']).toHaveBeenCalledOnce()
    expect(harness.internals.ptysById.get(sshBPty)?.connected).toBe(true)
  })

  it('classifies cwd-only nested PTYs against cold-cache same-provider paths only', async () => {
    const harness = makeHarness()
    harness.internals.resolvedWorktreeCache = null
    const localChildId = 'repo-local-child::/local/project/nested'
    const wslChildId = 'repo-wsl-child::C:\\work\\project\\nested'
    const sshChildId = 'repo-ssh-a-child::/srv/a/project/nested'
    const folderChildId = 'repo-folder-child::/srv/b/folder/nested'
    harness.repos.push(
      {
        id: 'repo-shadow-other-host',
        path: '/srv/a/project/nested',
        displayName: 'other-host-shadow',
        badgeColor: '#000000',
        addedAt: 0,
        connectionId: 'box-c'
      },
      {
        id: 'repo-local-child',
        path: '/local/project/nested',
        displayName: 'local-child',
        badgeColor: '#000000',
        addedAt: 0
      },
      {
        id: 'repo-wsl-child',
        path: 'C:\\work\\project\\nested',
        displayName: 'wsl-child',
        badgeColor: '#000000',
        addedAt: 0,
        executionHostId: 'local'
      },
      {
        id: 'repo-ssh-a-child',
        path: '/srv/a/project/nested',
        displayName: 'ssh-a-child',
        badgeColor: '#000000',
        addedAt: 0,
        connectionId: 'box-a'
      },
      {
        id: 'repo-folder-child',
        path: '/srv/b/folder/nested',
        displayName: 'folder-child',
        badgeColor: '#000000',
        addedAt: 0,
        connectionId: 'box-b'
      }
    )
    const cases: {
      label: string
      provider: ProviderKey
      parentId: string
      childId: string
      cwd: string
      ptyId: string
    }[] = [
      {
        label: 'local',
        provider: 'local',
        parentId: LOCAL_WORKTREE_ID,
        childId: localChildId,
        cwd: '/local/project/nested/src',
        ptyId: 'pty-local-nested'
      },
      {
        label: 'WSL-local',
        provider: 'local',
        parentId: WSL_WORKTREE_ID,
        childId: wslChildId,
        cwd: 'C:\\work\\project\\nested\\src',
        ptyId: 'pty-wsl-nested'
      },
      {
        label: 'SSH',
        provider: 'box-a',
        parentId: SSH_A_WORKTREE_ID,
        childId: sshChildId,
        cwd: '/srv/a/project/nested/src',
        ptyId: 'ssh:box-a@@nested'
      },
      {
        label: 'folder SSH',
        provider: 'box-b',
        parentId: folderWorkspaceKey(SSH_FOLDER.id),
        childId: folderChildId,
        cwd: '/srv/b/folder/nested/src',
        ptyId: 'ssh:box-b@@folder-nested'
      }
    ]

    for (const nested of cases) {
      harness.sessions[nested.provider].splice(0, Number.POSITIVE_INFINITY, {
        id: nested.ptyId,
        cwd: nested.cwd
      })
      const parent = await harness.runtime.listTerminals(`id:${nested.parentId}`)
      expect(
        parent.terminals.map((terminal) => terminal.ptyId),
        `${nested.label} parent must not adopt its nested child's PTY`
      ).not.toContain(nested.ptyId)

      const child = await harness.runtime.listTerminals(`id:${nested.childId}`)
      expect(
        child.terminals.map((terminal) => terminal.ptyId),
        `${nested.label} child must retain its cwd-only PTY`
      ).toContain(nested.ptyId)
    }

    const sshTarget = harness.internals.resolveScopedPtyControllerInventoryTarget(
      SSH_A_WORKTREE_ID,
      null,
      'box-a'
    )
    expect(sshTarget).not.toBeNull()
    const sshCandidates = harness.internals.listScopedPtyClassificationWorktrees(sshTarget!)
    expect(sshCandidates.map((candidate) => candidate.id)).toContain(sshChildId)
    expect(sshCandidates.map((candidate) => candidate.id)).not.toContain(
      'repo-shadow-other-host::/srv/a/project/nested'
    )
  })

  it('partitions duplicate-path and nested project-group folders by owning host', () => {
    const harness = makeHarness()
    harness.internals.resolvedWorktreeCache = null
    harness.projectGroups.push(
      {
        id: 'group-root',
        name: 'Root',
        parentPath: null,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      },
      {
        id: 'group-child',
        name: 'Child',
        parentPath: null,
        parentGroupId: 'group-root',
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      }
    )
    harness.repos.push(
      {
        id: 'repo-local-folder-shadow',
        path: '/srv/a/project/duplicate-folder',
        displayName: 'local folder shadow',
        badgeColor: '#000000',
        addedAt: 0
      },
      {
        id: 'repo-group-descendant',
        path: '/outside/group-repo',
        displayName: 'group repo',
        badgeColor: '#000000',
        addedAt: 0,
        connectionId: 'box-a',
        projectGroupId: 'group-child'
      }
    )
    const folderBase = {
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    } as const
    harness.folderWorkspaces.push(
      {
        ...folderBase,
        id: 'folder-local-shadow',
        projectGroupId: 'unused-local',
        name: 'Local shadow',
        folderPath: '/srv/a/project/duplicate-folder'
      },
      {
        ...folderBase,
        id: 'folder-ssh-owner',
        projectGroupId: 'unused-ssh',
        name: 'SSH owner',
        folderPath: '/srv/a/project/duplicate-folder',
        connectionId: 'box-a'
      },
      {
        ...folderBase,
        id: 'folder-group-owner',
        projectGroupId: 'group-root',
        name: 'Group owner',
        folderPath: '/srv/a/project/group-folder'
      }
    )
    const target = harness.internals.resolveScopedPtyControllerInventoryTarget(
      SSH_A_WORKTREE_ID,
      null,
      'box-a'
    )
    expect(target).not.toBeNull()

    const candidateIds = harness.internals
      .listScopedPtyClassificationWorktrees(target!)
      .map((candidate) => candidate.id)

    expect(candidateIds).toContain(folderWorkspaceKey('folder-ssh-owner'))
    expect(candidateIds).toContain(folderWorkspaceKey('folder-group-owner'))
    expect(candidateIds).not.toContain(folderWorkspaceKey('folder-local-shadow'))
  })

  it('builds large classifier and mobile owner indexes with linear catalog passes', async () => {
    const harness = makeHarness()
    harness.internals.resolvedWorktreeCache = null
    const scale = 250
    for (let index = 0; index < scale; index += 1) {
      const repoId = `repo-scale-${index}`
      const path = `/local/project/scale-${index}`
      const worktreeId = `${repoId}::${path}`
      harness.repos.push({
        id: repoId,
        path,
        displayName: repoId,
        badgeColor: '#000000',
        addedAt: 0
      })
      harness.meta[worktreeId] = { hostId: 'local' }
      harness.folderWorkspaces.push({
        id: `folder-scale-${index}`,
        projectGroupId: `unused-group-${index}`,
        name: `Folder ${index}`,
        folderPath: path,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      })
    }
    const target = harness.internals.resolveScopedPtyControllerInventoryTarget(
      LOCAL_WORKTREE_ID,
      null,
      null
    )
    expect(target).not.toBeNull()
    const resolver = vi.spyOn(harness.internals, 'resolveScopedPtyControllerInventoryTarget')
    harness.store.getRepos.mockClear()
    harness.store.getAllWorktreeMeta.mockClear()
    harness.store.getFolderWorkspaces.mockClear()

    const candidates = harness.internals.listScopedPtyClassificationWorktrees(target!)

    expect(candidates).toHaveLength(scale * 2 + 1)
    expect(resolver).not.toHaveBeenCalled()
    expect(harness.store.getRepos).toHaveBeenCalledOnce()
    expect(harness.store.getAllWorktreeMeta).toHaveBeenCalledOnce()
    expect(harness.store.getFolderWorkspaces).toHaveBeenCalledOnce()
    const folderResolver = vi.spyOn(harness.internals, 'resolveFolderWorkspaceConnectionId')
    const ptyId = 'pty-scale-mobile'
    harness.session.tabsByWorktree[LOCAL_WORKTREE_ID] = [
      {
        id: 'scale-mobile-tab',
        ptyId,
        worktreeId: LOCAL_WORKTREE_ID,
        title: 'Scale mobile',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
    harness.sessions.local.push({ id: ptyId, cwd: '/local/project', worktreeId: LOCAL_WORKTREE_ID })
    harness.store.getRepos.mockClear()
    harness.store.getProjectGroups.mockClear()
    harness.store.getFolderWorkspaces.mockClear()
    harness.internals.resolvedWorktreeCache = {
      worktrees: harness.worktrees,
      platformByRepoId: new Map(),
      expiresAt: Number.POSITIVE_INFINITY
    }

    await harness.runtime.listMobileSessionTabs(`id:${LOCAL_WORKTREE_ID}`)
    await harness.runtime.activateMobileSessionTab(`id:${LOCAL_WORKTREE_ID}`, 'scale-mobile-tab')
    await harness.runtime.listAllMobileSessionTabs()
    harness.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })

    expect(folderResolver).not.toHaveBeenCalled()
    expect(harness.store.getRepos.mock.calls.length).toBeLessThanOrEqual(32)
    expect(harness.store.getProjectGroups.mock.calls.length).toBeLessThanOrEqual(16)
    expect(harness.store.getFolderWorkspaces.mock.calls.length).toBeLessThanOrEqual(16)
  })

  it('allows distinct full worktree ids that share a repo id across hosts', async () => {
    const harness = makeHarness()
    const repoId = 'repo-split-owner'
    const localWorktreeId = `${repoId}::/local/split-owner`
    const sshWorktreeId = `${repoId}::/remote/split-owner`
    const localPty = 'pty-split-local'
    const sshPty = 'ssh:box-a@@split-remote'
    harness.repos.push(
      {
        id: repoId,
        path: '/local/split-owner',
        displayName: 'split local',
        badgeColor: '#000000',
        addedAt: 0
      },
      {
        id: repoId,
        path: '/remote/split-owner',
        displayName: 'split ssh',
        badgeColor: '#000000',
        addedAt: 0,
        connectionId: 'box-a'
      }
    )
    harness.worktrees.push(
      resolvedWorktree(localWorktreeId, repoId, '/local/split-owner', 'local'),
      resolvedWorktree(sshWorktreeId, repoId, '/remote/split-owner', 'ssh:box-a')
    )
    for (const [worktreeId, tabId, ptyId] of [
      [localWorktreeId, 'split-local-tab', localPty],
      [sshWorktreeId, 'split-ssh-tab', sshPty]
    ] as const) {
      harness.session.tabsByWorktree[worktreeId] = [
        {
          id: tabId,
          ptyId,
          worktreeId,
          title: tabId,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
    harness.sessions.local.push({
      id: localPty,
      cwd: '/local/split-owner',
      worktreeId: localWorktreeId
    })
    harness.sessions['box-a'].push({
      id: sshPty,
      cwd: '/remote/split-owner',
      worktreeId: sshWorktreeId
    })

    const local = await harness.runtime.listMobileSessionTabs(`id:${localWorktreeId}`)
    expect(local.tabs.some((tab) => tab.type === 'terminal' && tab.ptyId === localPty)).toBe(true)
    await expect(
      harness.runtime.activateMobileSessionTab(`id:${localWorktreeId}`, 'split-local-tab')
    ).resolves.toMatchObject({ worktree: localWorktreeId })
    const remote = await harness.runtime.listMobileSessionTabs(`id:${sshWorktreeId}`)
    expect(remote.tabs.some((tab) => tab.type === 'terminal' && tab.ptyId === sshPty)).toBe(true)
    await expect(
      harness.runtime.closeMobileSessionTab(`id:${sshWorktreeId}`, 'split-ssh-tab')
    ).resolves.toEqual({ closed: true })
  })

  it('deduplicates repeated registrations on the same local or SSH provider', async () => {
    const harness = makeHarness()
    harness.repos.push(
      { ...harness.repos.find((repo) => repo.id === 'repo-local')! },
      { ...harness.repos.find((repo) => repo.id === 'repo-ssh-a')! }
    )
    harness.worktrees.push(
      resolvedWorktree(LOCAL_WORKTREE_ID, 'repo-local', '/local/project', 'local'),
      resolvedWorktree(SSH_A_WORKTREE_ID, 'repo-ssh-a', '/srv/a/project', 'ssh:box-a')
    )
    const localPty = 'pty-duplicate-local-registration'
    const sshPty = 'ssh:box-a@@duplicate-registration'
    harness.sessions.local.push({
      id: localPty,
      cwd: '/local/project',
      worktreeId: LOCAL_WORKTREE_ID
    })
    harness.sessions['box-a'].push({
      id: sshPty,
      cwd: '/srv/a/project',
      worktreeId: SSH_A_WORKTREE_ID
    })
    harness.session.tabsByWorktree[SSH_A_WORKTREE_ID] = [
      {
        id: 'duplicate-registration-tab',
        ptyId: sshPty,
        worktreeId: SSH_A_WORKTREE_ID,
        title: 'Duplicate registration',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]

    const local = await harness.runtime.listTerminals(`id:${LOCAL_WORKTREE_ID}`)
    expect(local.terminals.map((terminal) => terminal.ptyId)).toContain(localPty)
    expect(harness.internals.ptysById.get(localPty)?.connected).toBe(true)
    harness.clearProviderCalls()
    const remote = await harness.runtime.listTerminals(`id:${SSH_A_WORKTREE_ID}`)
    expect(remote.terminals.map((terminal) => terminal.ptyId)).toContain(sshPty)
    expect(harness.providers['box-a']).toHaveBeenCalledOnce()
    expect(harness.internals.ptysById.get(sshPty)?.connected).toBe(true)
    await harness.runtime.listMobileSessionTabs(`id:${SSH_A_WORKTREE_ID}`)
    await expect(
      harness.runtime.closeMobileSessionTab(`id:${SSH_A_WORKTREE_ID}`, 'duplicate-registration-tab')
    ).resolves.toEqual({ closed: true })
  })

  it('rejects a folder id registered on local and SSH hosts', async () => {
    const harness = makeHarness()
    harness.folderWorkspaces.push({
      ...SSH_FOLDER,
      name: 'Conflicting local folder',
      folderPath: '/local/conflicting-folder',
      connectionId: null
    })

    await expect(
      harness.runtime.listMobileSessionTabs(`id:${folderWorkspaceKey(SSH_FOLDER.id)}`)
    ).rejects.toThrow('selector_ambiguous')
  })

  it('accepts duplicate folder registrations on the same SSH host', async () => {
    const harness = makeHarness()
    harness.folderWorkspaces.push({ ...SSH_FOLDER })
    const folderWorktreeId = folderWorkspaceKey(SSH_FOLDER.id)
    const ptyId = 'ssh:box-b@@same-folder-registration'
    harness.session.tabsByWorktree[folderWorktreeId] = [
      {
        id: 'same-folder-tab',
        ptyId,
        worktreeId: folderWorktreeId,
        title: 'Same folder',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
    harness.sessions['box-b'].push({
      id: ptyId,
      cwd: SSH_FOLDER.folderPath,
      worktreeId: folderWorktreeId
    })

    const terminals = await harness.runtime.listTerminals(`id:${folderWorktreeId}`)
    expect(terminals.terminals.map((terminal) => terminal.ptyId)).toContain(ptyId)
    await expect(
      harness.runtime.listMobileSessionTabs(`id:${folderWorktreeId}`)
    ).resolves.toMatchObject({ worktree: folderWorktreeId })
  })

  it('keeps runtime-owned folder mobile tabs unambiguous without provider liveness', async () => {
    const harness = makeHarness()
    const runtimeFolder = {
      ...SSH_FOLDER,
      id: 'folder-runtime-owner',
      name: 'Runtime folder',
      folderPath: '/runtime/folder',
      connectionId: null,
      executionHostId: 'runtime:environment-1'
    }
    harness.folderWorkspaces.push(runtimeFolder)
    const worktreeId = folderWorkspaceKey(runtimeFolder.id)
    const ptyId = 'runtime-folder-pty'
    harness.session.tabsByWorktree[worktreeId] = [
      {
        id: 'runtime-folder-tab',
        ptyId,
        worktreeId,
        title: 'Runtime folder',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
    const leafId = '11111111-1111-4111-8111-111111111111'
    harness.session.terminalLayoutsByTabId['runtime-folder-tab'] = {
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId]: ptyId }
    }
    harness.runtime.preAllocateHandleForPty(ptyId)
    harness.runtime.registerPty(ptyId, worktreeId, null, {
      tabId: 'runtime-folder-tab',
      leafId
    })

    const listed = await harness.runtime.listMobileSessionTabs(`id:${worktreeId}`)
    expect(listed.tabs.some((tab) => tab.type === 'terminal' && tab.ptyId === ptyId)).toBe(true)
    expect(harness.internals.ptysById.get(ptyId)?.connected).toBe(true)
    await expect(
      harness.runtime.activateMobileSessionTab(`id:${worktreeId}`, 'runtime-folder-tab')
    ).resolves.toMatchObject({ worktree: worktreeId })
    expect(harness.listProcesses).not.toHaveBeenCalled()
    expect(harness.listProcessesWithHostScope).not.toHaveBeenCalled()
    expect(harness.providers.local).not.toHaveBeenCalled()
    expect(harness.providers['box-a']).not.toHaveBeenCalled()
    expect(harness.providers['box-b']).not.toHaveBeenCalled()
    expect(harness.providers['box-c']).not.toHaveBeenCalled()
    await expect(
      harness.runtime.closeMobileSessionTab(`id:${worktreeId}`, 'runtime-folder-tab')
    ).rejects.toThrow('terminal_host_scope_mismatch')
    expect(harness.kill).not.toHaveBeenCalled()
  })
  it('queries but never exposes SSH mobile tabs for a duplicate-owner worktree id', async () => {
    const harness = makeHarness()
    harness.internals.resolvedWorktreeCache = null
    const duplicateWorktreeId = 'repo-duplicate::/shared/project'
    harness.repos.push(
      {
        id: 'repo-duplicate',
        path: '/shared/project',
        displayName: 'local-duplicate',
        badgeColor: '#000000',
        addedAt: 0
      },
      {
        id: 'repo-duplicate',
        path: '/shared/project',
        displayName: 'ssh-duplicate',
        badgeColor: '#000000',
        addedAt: 0,
        connectionId: 'box-a'
      }
    )
    const recoveredPty = 'ssh:box-a@@recovered-mobile'
    harness.session.tabsByWorktree[duplicateWorktreeId] = [
      {
        id: 'recovered-tab',
        ptyId: recoveredPty,
        worktreeId: duplicateWorktreeId,
        title: 'Recovered',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
    harness.sessions['box-a'].push({
      id: recoveredPty,
      cwd: '/shared/project',
      worktreeId: duplicateWorktreeId
    })
    const unrelatedPty = 'ssh:box-c@@unrelated-live'
    harness.runtime.registerPty(unrelatedPty, SSH_C_WORKTREE_ID, 'box-c')
    harness.internals.sshRelayRecoveryGenerationByTargetId.set('box-a', 1)
    const notify = vi.spyOn(harness.internals, 'notifyMobileSessionTabsChangedNow')

    await harness.internals.publishRecoveredSshMobileSessionTabs('box-a', 1)

    expect(harness.providers['box-a']).toHaveBeenCalledOnce()
    expect(harness.providers.local).not.toHaveBeenCalled()
    expect(harness.providers['box-b']).not.toHaveBeenCalled()
    expect(harness.providers['box-c']).not.toHaveBeenCalled()
    expect(harness.store.getWorkspaceSession).toHaveBeenCalledWith('ssh:box-a')
    expect(notify).not.toHaveBeenCalledWith(duplicateWorktreeId)
    expect(harness.internals.mobileSessionTabsByWorktree.has(duplicateWorktreeId)).toBe(false)
    expect(harness.internals.ptysById.get(recoveredPty)?.connected).toBe(true)
    await expect(
      harness.runtime.listMobileSessionTabs(`id:${duplicateWorktreeId}`)
    ).rejects.toThrow('selector_ambiguous')
    await expect(
      harness.runtime.closeMobileSessionTab(`id:${duplicateWorktreeId}`, 'recovered-tab')
    ).rejects.toThrow('selector_ambiguous')
    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.internals.ptysById.get(unrelatedPty)?.connected).toBe(true)
  })

  it('rechecks exact ownership after deferred provider inventory before publishing or acting', async () => {
    for (const mode of ['recovery', 'list', 'activate'] as const) {
      const harness = makeHarness()
      const ptyId = 'ssh:box-a@@owner-race'
      harness.session.tabsByWorktree[SSH_A_WORKTREE_ID] = [
        {
          id: 'owner-race-tab',
          ptyId,
          worktreeId: SSH_A_WORKTREE_ID,
          title: 'Owner race',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
      harness.sessions['box-a'].push({
        id: ptyId,
        cwd: '/srv/a/project',
        worktreeId: SSH_A_WORKTREE_ID
      })
      let release!: (sessions: (typeof harness.sessions)['box-a']) => void
      const deferred = new Promise<(typeof harness.sessions)['box-a']>((resolve) => {
        release = resolve
      })
      harness.providers['box-a'].mockImplementationOnce(() => deferred)
      harness.internals.sshRelayRecoveryGenerationByTargetId.set('box-a', 1)
      const notify = vi.spyOn(harness.internals, 'notifyMobileSessionTabsChangedNow')
      const pending =
        mode === 'recovery'
          ? harness.internals.publishRecoveredSshMobileSessionTabs('box-a', 1)
          : mode === 'list'
            ? harness.runtime.listMobileSessionTabs(`id:${SSH_A_WORKTREE_ID}`)
            : harness.runtime.activateMobileSessionTab(`id:${SSH_A_WORKTREE_ID}`, 'owner-race-tab')
      await vi.waitFor(() => expect(harness.providers['box-a']).toHaveBeenCalledOnce())
      harness.repos.push({
        ...harness.repos.find((repo) => repo.id === 'repo-ssh-a')!,
        connectionId: undefined
      })
      release(harness.sessions['box-a'])
      if (mode === 'recovery') {
        await pending
        expect(notify).not.toHaveBeenCalledWith(SSH_A_WORKTREE_ID)
      } else {
        await expect(pending).rejects.toThrow('selector_ambiguous')
      }
      expect(harness.internals.mobileSessionTabsByWorktree.has(SSH_A_WORKTREE_ID)).toBe(false)
      expect(harness.kill).not.toHaveBeenCalled()
    }
  })

  it('does not guess when the same exact worktree id has multiple execution owners', async () => {
    const harness = makeHarness()
    harness.repos.push({
      ...harness.repos[0]!,
      connectionId: 'box-a'
    })
    harness.worktrees.push(
      resolvedWorktree(LOCAL_WORKTREE_ID, 'repo-local', '/local/project', 'ssh:box-a')
    )
    const retainedPty = 'ssh:box-a@@ambiguous-owner'
    harness.runtime.registerPty(retainedPty, LOCAL_WORKTREE_ID, 'box-a')

    const result = await harness.runtime.listTerminals(`id:${LOCAL_WORKTREE_ID}`)

    expect(harness.listProcesses).not.toHaveBeenCalled()
    expect(harness.listProcessesWithHostScope).not.toHaveBeenCalled()
    expect(result.terminals.map((terminal) => terminal.ptyId)).toContain(retainedPty)
    expect(harness.internals.ptysById.get(retainedPty)?.connected).toBe(true)
  })
})
