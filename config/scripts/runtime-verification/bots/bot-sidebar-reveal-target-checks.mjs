import assert from 'node:assert/strict'

export async function checkRevealTargets({ page, reset, save, theme }) {
  async function usefulVisibility(selector) {
    return page
      .locator(selector)
      .first()
      .evaluate((element) => {
        const box = element.getBoundingClientRect()
        const inner = element.closest('[data-worktree-sidebar]')
        const outer = element.closest('[data-sidebar-content-viewport]')
        const innerBox = inner.getBoundingClientRect()
        const outerBox = outer.getBoundingClientRect()
        const ownHeader = element.closest('[data-worktree-sticky-header-active]')
        const ownLayer = ownHeader ? Number.parseInt(getComputedStyle(ownHeader).zIndex) || 0 : 0
        const sticky = [...inner.querySelectorAll('[data-worktree-sticky-header-active]')]
          .filter((header) => !header.contains(element))
          .filter((header) => (Number.parseInt(getComputedStyle(header).zIndex) || 0) >= ownLayer)
          .map((header) => header.getBoundingClientRect())
          .filter(
            (header) =>
              header.bottom > outerBox.top &&
              header.top < outerBox.bottom &&
              header.top < box.bottom &&
              header.bottom > box.top
          )
        const top = Math.max(innerBox.top, outerBox.top, ...sticky.map((header) => header.bottom))
        const bottom = Math.min(innerBox.bottom, outerBox.bottom)
        return {
          box: box.toJSON(),
          inner: innerBox.toJSON(),
          outer: outerBox.toJSON(),
          top,
          bottom,
          full: box.top >= top - 0.5 && box.bottom <= bottom + 0.5
        }
      })
  }
  async function waitFull(selector) {
    await page.locator(selector).first().waitFor({ state: 'attached' })
    await page.waitForFunction((selector) => {
      const element = document.querySelector(selector)
      if (!element) {
        return false
      }
      const box = element.getBoundingClientRect()
      const inner = element.closest('[data-worktree-sidebar]').getBoundingClientRect()
      const outer = element.closest('[data-sidebar-content-viewport]').getBoundingClientRect()
      return (
        box.top >= Math.max(inner.top, outer.top) - 0.5 &&
        box.bottom <= Math.min(inner.bottom, outer.bottom) + 0.5
      )
    }, selector)
    await page.evaluate(() => {
      window.__c3ScrollSample = null
    })
    await page.waitForFunction(() => {
      const owners = [
        document.querySelector('[data-worktree-sidebar]'),
        document.querySelector('[data-sidebar-content-viewport]')
      ]
      const key = owners.map((element) => element.scrollTop).join(',')
      const previous = window.__c3ScrollSample
      const quiet = previous?.key === key ? previous.quiet + 1 : 0
      window.__c3ScrollSample = { key, quiet }
      return quiet >= 4
    })
    const actual = await usefulVisibility(selector)
    assert.ok(
      actual.full,
      `fitting useful bounds clear both clips and active sticky headers: ${JSON.stringify(actual)}`
    )
  }
  for (const reduced of [false, true]) {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
    const mode = reduced ? 'reduced' : 'motion'
    await reset()
    await page.evaluate(async () => {
      const { sidebarCorpus } =
        await import('/src/components/sidebar/worktree-list/listing/host-status-test-fixtures.ts')
      const { useAppStore } = await import('/src/store/index.ts')
      const corpus = sidebarCorpus(2, 2)
      const first = corpus.worktrees[0]
      const rows = Array.from({ length: 80 }, (_, index) => ({
        ...first,
        id: `c3-remote-${index}`,
        path: `/proof/remote-${index}`,
        displayName: `Remote workspace ${index}`,
        sortOrder: index,
        manualOrder: index,
        lastActivityAt: 80 - index
      }))
      useAppStore.setState({
        worktreesByRepo: {
          [first.repoId]: rows,
          [corpus.repos[1].id]: corpus.worktrees.filter((row) => row.repoId === corpus.repos[1].id)
        },
        sortBy: 'manual',
        visibleWorkspaceHostIds: ['runtime:host-0', 'runtime:host-1'],
        activeWorktreeId: null,
        activeWorkspaceKey: null,
        activeWorkspaceExecutionHostId: null
      })
    })
    await page.waitForFunction(
      () => document.querySelector('[data-worktree-sidebar]')?.scrollHeight > 1000
    )
    const remoteId = await page.evaluate(() =>
      Array.from({ length: 80 }, (_, index) => `c3-remote-${index}`).find(
        (id) => !document.querySelector(`[data-worktree-id="${id}"]`)
      )
    )
    assert.ok(remoteId, 'a generated target starts virtualized offscreen')
    await page.evaluate(async (id) => {
      const { useAppStore } = await import('/src/store/index.ts')
      useAppStore
        .getState()
        .revealWorktreeInSidebar(id, { behavior: 'smooth', executionHostId: 'runtime:host-0' })
    }, remoteId)
    const remoteSelector = `[data-worktree-id="${remoteId}"]`
    await waitFull(remoteSelector)
    await save(`virtual-remote-${mode}-${theme}`, {
      target: remoteId,
      wasMounted: false,
      visibility: await usefulVisibility(remoteSelector)
    })
    const header = page.locator('[data-host-header-drag-id="runtime:host-0"]').first()
    await header.waitFor({ state: 'attached' })
    await header.evaluate(async (element) => {
      const { revealElementInScrollContainer } =
        await import('/src/components/sidebar/worktree-list/navigation/worktree-sidebar-reveal.ts')
      revealElementInScrollContainer(element.closest('[data-worktree-sidebar]'), element, 'smooth')
    })
    await waitFull('[data-host-header-drag-id="runtime:host-0"]')
    await save(`remote-host-header-${mode}-${theme}`, {
      visibility: await usefulVisibility('[data-host-header-drag-id="runtime:host-0"]')
    })

    await reset()
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/store/index.ts')
      const { makeFolderWorkspace } =
        await import('/src/store/folder-workspaces/folder-workspace.test-fixture.ts')
      useAppStore.setState((state) => ({
        projectGroups: [
          {
            id: 'c3-folders',
            name: 'Folder samples',
            parentPath: '/proof',
            parentGroupId: null,
            createdFrom: 'manual',
            tabOrder: 0,
            isCollapsed: false,
            color: null,
            createdAt: 1,
            updatedAt: 1
          }
        ],
        folderWorkspaces: [
          ...state.folderWorkspaces,
          makeFolderWorkspace({
            id: 'c3-folder',
            name: 'Folder workspace',
            projectGroupId: 'c3-folders'
          })
        ],
        activeWorktreeId: 'folder:c3-folder',
        activeWorkspaceKey: 'folder:c3-folder',
        activeWorkspaceExecutionHostId: null
      }))
    })
    await page.getByRole('button', { name: 'Reveal current', exact: true }).click()
    await waitFull('[data-worktree-id="folder:c3-folder"]')
    await save(`folder-workspace-${mode}-${theme}`, {
      visibility: await usefulVisibility('[data-worktree-id="folder:c3-folder"]')
    })
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/store/index.ts')
      useAppStore.getState().revealSidebarRow('project-group:c3-folders', { behavior: 'smooth' })
    })
    await waitFull('[id="worktree-list-option-project-group%3Ac3-folders"]')
    await save(`folder-header-${mode}-${theme}`)

    await reset()
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/store/index.ts')
      const { seedWorkspaces } =
        await import('/src/components/sidebar/worktree-card-slot-fixture-seeds.ts')
      const { expandWorktreeAgentList } =
        await import('/src/components/sidebar/workspace-card/activity/worktree-card-agents-expansion-state.ts')
      useAppStore.setState({ repos: [], worktreesByRepo: {} })
      seedWorkspaces(
        [
          {
            id: 'c3-large',
            name: 'oversized-reveal',
            agents: Array.from({ length: 8 }, () => ({
              agentType: 'codex',
              state: 'working',
              minutesAgo: 1,
              toolName: 'Read',
              toolInput: 'proof.ts'
            }))
          }
        ],
        Date.now()
      )
      expandWorktreeAgentList('c3-large', undefined)
    })
    const large = page.locator('[data-worktree-id="c3-large"]')
    await large.waitFor({ state: 'attached' })
    assert.ok(
      await large.evaluate(
        (element) =>
          element.offsetHeight > element.closest('[data-sidebar-content-viewport]').clientHeight
      ),
      'expanded agent card is naturally oversized'
    )
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/store/index.ts')
      useAppStore.getState().revealWorktreeInSidebar('c3-large', { behavior: 'smooth' })
    })
    await page.getByText('oversized-reveal', { exact: true }).first().waitFor()
    const title = page.getByText('oversized-reveal', { exact: true }).first()
    await title.evaluate((element) => element.setAttribute('data-c3-leading-title', ''))
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-worktree-id="c3-large"]')
      const title = [...row.querySelectorAll('span')].find(
        (element) => element.textContent === 'oversized-reveal' && element.children.length === 0
      )
      const box = title?.getBoundingClientRect()
      const outer = row.closest('[data-sidebar-content-viewport]').getBoundingClientRect()
      return box && box.top >= outer.top - 0.5 && box.bottom <= outer.bottom + 0.5
    })
    await waitFull('[data-c3-leading-title]')
    assert.ok(
      await title.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const inner = element.closest('[data-worktree-sidebar]').getBoundingClientRect()
        return box.top >= inner.top && box.bottom <= inner.bottom
      }),
      'oversized title remains reachable inside the inner clip'
    )
    await save(`oversized-leading-${mode}-${theme}`, {
      oversized: true,
      title: await title.boundingBox(),
      row: await large.boundingBox()
    })
    const inner = page.locator('[data-worktree-sidebar]')
    const initialOffset = await inner.evaluate((element) => element.scrollTop)
    const clip = await large.evaluate((element) => {
      const inner = element.closest('[data-worktree-sidebar]').getBoundingClientRect()
      const outer = element.closest('[data-sidebar-content-viewport]').getBoundingClientRect()
      return {
        x: inner.left + 30,
        y: (Math.max(inner.top, outer.top) + Math.min(inner.bottom, outer.bottom)) / 2
      }
    })
    await page.mouse.move(clip.x, clip.y)
    await page.mouse.wheel(0, 10000)
    await page.waitForFunction(
      (top) => document.querySelector('[data-worktree-sidebar]').scrollTop > top,
      initialOffset
    )
    const tail = large.locator('.compact-agent-row').last()
    await tail.evaluate(async (element) => {
      element.setAttribute('data-c3-tail', '')
      const { revealElementInScrollContainer } =
        await import('/src/components/sidebar/worktree-list/navigation/worktree-sidebar-reveal.ts')
      revealElementInScrollContainer(element.closest('[data-worktree-sidebar]'), element, 'auto')
    })
    await waitFull('[data-c3-tail]')
    await save(`oversized-tail-${mode}-${theme}`, {
      visibility: await usefulVisibility('[data-c3-tail]')
    })
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
}
