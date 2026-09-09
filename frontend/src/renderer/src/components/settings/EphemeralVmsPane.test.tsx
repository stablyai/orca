// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EphemeralVmsPane } from './EphemeralVmsPane'

const toastMocks = vi.hoisted(() => ({
  error: vi.fn()
}))

const storeMocks = vi.hoisted(() => ({
  openModal: vi.fn()
}))

const mockStoreState = {
  activeRepoId: null,
  activeWorktreeId: null,
  openModal: storeMocks.openModal,
  recordFeatureInteraction: vi.fn(),
  projects: [],
  repos: [],
  settings: null,
  worktreesByRepo: {},
  // Read by useActiveDevServer/useConnectedDevServers, which
  // EphemeralVmsPane now calls to resolve a devServerId for its setup terminal.
  devServers: [],
  activeDevServerId: null
}

vi.mock('sonner', () => ({
  toast: {
    error: toastMocks.error
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mockStoreState), {
    getState: () => mockStoreState
  })
}))

const roots: Root[] = []

async function renderPane(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<EphemeralVmsPane />)
  })
  return container
}

describe('EphemeralVmsPane', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    toastMocks.error.mockClear()
    storeMocks.openModal.mockClear()
    Object.assign(globalThis.window, {
      api: {
        ephemeralVm: {
          listRecipeCatalog: vi.fn().mockResolvedValue([
            {
              repoId: 'repo-1',
              repoName: 'Repo',
              repoPath: '/repo',
              diagnostics: [],
              recipes: [
                {
                  id: 'cloud-sandbox',
                  name: 'Cloud Sandbox',
                  create: './scripts/orca-vm/cloud-sandbox.start.sh',
                  destroy: './scripts/orca-vm/cloud-sandbox.cleanup.sh'
                }
              ]
            }
          ]),
          doctor: vi.fn().mockResolvedValue({
            recipeId: 'cloud-sandbox',
            repoPath: '/repo',
            ok: true,
            checks: []
          })
        },
        skills: {
          discover: vi.fn().mockResolvedValue({ skills: [] })
        },
        cli: {
          getInstallStatus: vi.fn().mockResolvedValue({ state: 'installed', pathConfigured: true }),
          getWslInstallStatus: vi
            .fn()
            .mockResolvedValue({ state: 'installed', pathConfigured: true })
        },
        runtime: {
          call: vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
            if (method === 'cli.getInstallStatus') {
              return { ok: true, result: { state: 'installed', pathConfigured: true } }
            }
            if (method === 'cli.getWslInstallStatus') {
              return { ok: true, result: { state: 'installed', pathConfigured: true } }
            }
            throw new Error(
              `Unexpected runtime.call method in test stub: ${method}, ${JSON.stringify(params)}`
            )
          })
        },
        platform: {
          get: vi.fn().mockReturnValue({ platform: 'darwin' })
        },
        ui: {
          writeClipboardText: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
  })

  it('renders the skill panel and recipe, and opens the composer with the recipe selected', async () => {
    const container = await renderPane()

    await vi.waitFor(() => expect(container.textContent).toContain('Cloud Sandbox'))
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Per-Workspace Environments skill')
    )
    expect(container.textContent).toContain('What the skill does, with you')
    const useButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Use in workspace'
    )
    expect(useButton).toBeDefined()

    await act(async () => {
      useButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(storeMocks.openModal).toHaveBeenCalledWith('new-workspace-composer', {
      initialRepoId: 'repo-1',
      initialEphemeralVmRecipeId: 'cloud-sandbox',
      telemetrySource: 'settings'
    })
  })

  // CR-EVM-006/FE-TASK-EVM-004
  it('blocks opening the composer when the recipe doctor reports a fail check', async () => {
    window.api.ephemeralVm.doctor = vi.fn().mockResolvedValue({
      recipeId: 'cloud-sandbox',
      repoPath: '/repo',
      ok: false,
      checks: [{ id: 'repo.path', status: 'fail', message: 'Repo path does not exist' }]
    })
    const container = await renderPane()
    await vi.waitFor(() => expect(container.textContent).toContain('Cloud Sandbox'))
    const useButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Use in workspace'
    )

    await act(async () => {
      useButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(storeMocks.openModal).not.toHaveBeenCalled()
    // Dialog (Radix) renders via a portal into document.body, not `container`.
    await vi.waitFor(() => expect(document.body.textContent).toContain('Repo path does not exist'))
    // Blocking dialog has no "Continue anyway" action.
    expect(
      [...document.body.querySelectorAll('button')].some((b) => b.textContent === 'Continue anyway')
    ).toBe(false)
  })

  // CR-EVM-006/FE-TASK-EVM-004
  it('opens the composer after "Continue anyway" when the recipe doctor reports only a warn check', async () => {
    window.api.ephemeralVm.doctor = vi.fn().mockResolvedValue({
      recipeId: 'cloud-sandbox',
      repoPath: '/repo',
      ok: true,
      checks: [{ id: 'recipe.version', status: 'warn', message: 'Package version mismatch' }]
    })
    const container = await renderPane()
    await vi.waitFor(() => expect(container.textContent).toContain('Cloud Sandbox'))
    const useButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Use in workspace'
    )

    await act(async () => {
      useButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(storeMocks.openModal).not.toHaveBeenCalled()
    let continueButton: Element | undefined
    await vi.waitFor(() => {
      continueButton = [...document.body.querySelectorAll('button')].find(
        (button) => button.textContent === 'Continue anyway'
      )
      expect(continueButton).toBeDefined()
    })

    await act(async () => {
      continueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(storeMocks.openModal).toHaveBeenCalledWith('new-workspace-composer', {
      initialRepoId: 'repo-1',
      initialEphemeralVmRecipeId: 'cloud-sandbox',
      telemetrySource: 'settings'
    })
  })
})
