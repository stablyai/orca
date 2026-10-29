import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

const CLIENT_PROVENANCE = {
  automationId: 'desktop-automation',
  automationNameSnapshot: 'Nightly review',
  automationRunId: 'desktop-run',
  automationRunTitleSnapshot: 'Nightly review run',
  executionTargetType: 'local',
  executionTargetId: 'local',
  projectId: 'project-1',
  repoId: 'repo-1',
  hostId: 'local'
} as const

function createOnHost(
  showAutomation: () => unknown,
  params: Record<string, unknown>,
  methods = WORKTREE_METHODS
) {
  const createManagedWorktree = vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
  const fixture = {
    getRuntimeId: () => 'test-runtime',
    dedupeWorktreeCreate: <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
      run(),
    showRepo: vi.fn().mockResolvedValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 1,
      kind: 'git'
    }),
    showAutomation,
    listAutomationRuns: () => [],
    createManagedWorktree
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method worktree.create reaches, plus the id the dispatcher stamps on replies.
  const runtime = fixture as unknown as OrcaRuntimeService
  const response = new RpcDispatcher({ runtime, methods }).dispatch({
    id: 'req-1',
    authToken: 'tok',
    method: 'worktree.create',
    params: { repo: 'repo-1', name: 'desktop-automation-workspace', ...params }
  })
  return { response, createManagedWorktree }
}

const notFound = (): never => {
  throw new Error('Automation not found.')
}

// Why: only the desktop that owns a run can verify its dispatch token (#34433).
describe('worktree.create for another owner’s automation run', () => {
  it('creates a plain workspace for a dispatch token it cannot verify', async () => {
    const { response, createManagedWorktree } = createOnHost(notFound, {
      automationProvenanceRequest: {
        automationId: 'desktop-automation',
        automationRunId: 'desktop-run',
        dispatchToken: 'desktop-token',
        createRequestId: 'create-request-desktop'
      }
    })

    await expect(response).resolves.toMatchObject({ ok: true })
    expect(createManagedWorktree).toHaveBeenCalledWith(
      expect.not.objectContaining({ automationProvenance: expect.anything() })
    )
  })

  // Invariant: a client-origin label never grants ownership, sleep authority or create policy here.
  it('records the owner’s run as a client-origin label without automation create policy', async () => {
    const { response, createManagedWorktree } = createOnHost(notFound, {
      clientAutomationProvenance: CLIENT_PROVENANCE
    })

    await expect(response).resolves.toMatchObject({ ok: true })
    expect(createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        automationProvenance: {
          ...CLIENT_PROVENANCE,
          kind: 'created-by-automation',
          createdAt: expect.any(Number),
          origin: 'client'
        },
        allowLocalBaseFallback: true,
        wslUserAct: true
      })
    )
  })

  it('never labels a workspace with one of its own automations from a client record', async () => {
    const { response, createManagedWorktree } = createOnHost(() => ({ id: 'desktop-automation' }), {
      clientAutomationProvenance: CLIENT_PROVENANCE
    })

    await expect(response).resolves.toMatchObject({ ok: true })
    expect(createManagedWorktree).toHaveBeenCalledWith(
      expect.not.objectContaining({ automationProvenance: expect.anything() })
    )
  })

  it('drops an oversized label and still creates the workspace', async () => {
    // Why fresh modules: the warning is once per process, so this create must be the first to drop one.
    vi.resetModules()
    const { WORKTREE_METHODS: freshMethods } = await import('./worktree')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { response, createManagedWorktree } = createOnHost(
      notFound,
      {
        clientAutomationProvenance: {
          ...CLIENT_PROVENANCE,
          automationNameSnapshot: 'x'.repeat(1025)
        }
      },
      freshMethods
    )

    await expect(response).resolves.toMatchObject({ ok: true })
    expect(createManagedWorktree).toHaveBeenCalledWith(
      expect.not.objectContaining({ automationProvenance: expect.anything() })
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped a malformed client automation label')
    )
    warn.mockRestore()
  })

  it('surfaces an automation store failure', async () => {
    const { response, createManagedWorktree } = createOnHost(
      () => {
        throw new Error('database is locked')
      },
      { clientAutomationProvenance: CLIENT_PROVENANCE }
    )

    await expect(response).resolves.toMatchObject({ ok: false })
    expect(createManagedWorktree).not.toHaveBeenCalled()
  })
})
