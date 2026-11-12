// @vitest-environment happy-dom

import { act, Suspense, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import type { BundledSkillPlan } from '../../../shared/bundled-skill-plan'
import { installBodyOverlayAttributes } from '@/lib/overlay-interaction/body-overlay-attributes'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Toaster } from '@/components/ui/sonner'
import { SkillFreshnessNudge } from '@/components/skills/freshness/SkillFreshnessNudge'
import { planOf, sharedEntry } from '@/components/skills/bundled-skill-plan-fixtures.test-support'
import { lazyWithRetry } from './startup/lazy-with-retry'
import { useAppStore } from '../store/index'
import { useLazyModalMounts } from './use-lazy-modal-mounts'
import { useOnboardingAndFeatureTips } from './use-onboarding-and-feature-tips'

vi.mock('../store/index', async () => {
  const { create } = await import('zustand')
  const { FEATURE_TIP_SEEN_IDS } = await import('../../../shared/feature-tips')
  return {
    useAppStore: create((set) => ({
      activeModal: 'none',
      settings: {
        theme: 'light',
        voice: { enabled: true },
        aiVaultSearch: { enabled: true },
        dismissedSkillFreshnessNudges: []
      },
      persistedUIReady: true,
      // Every tip already seen, so startup prompts finish without opening one.
      featureTipsSeenIds: [...FEATURE_TIP_SEEN_IDS],
      featureInteractions: {},
      chatUiLaunchTipVariant: null,
      contextualToursAutoEligible: false,
      sshCredentialQueue: [],
      terminalStartupRestorationReady: true,
      openModal: (activeModal: string) => set({ activeModal }),
      markFeatureTipsSeen: vi.fn(),
      setChatUiLaunchTipVariant: (chatUiLaunchTipVariant: string) =>
        set({ chatUiLaunchTipVariant }),
      setContextualToursAutoEligible: vi.fn(),
      setContextualToursOnboardingVisible: vi.fn(),
      updateSettings: vi.fn(async () => undefined)
    }))
  }
})
const freshness = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  let plan: BundledSkillPlan | null = null
  return {
    get: () => plan,
    set: (next: BundledSkillPlan | null) => {
      plan = next
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
})
vi.mock('@/hooks/skills/freshness/useSkillFreshness', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useSkillFreshness: () => ({
      plan: useSyncExternalStore(freshness.subscribe, freshness.get),
      unsupported: null,
      loading: false,
      error: null,
      refresh: vi.fn()
    })
  }
})
vi.mock('@/hooks/skills/runtime/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ bundledSkillTarget: { kind: 'local' } })
}))
vi.mock('@/components/skills/freshness/skill-freshness-auto-update', () => ({
  autoUpdateUnmodifiedSkills: () => new Set<string>()
}))
vi.mock('@/components/skills/freshness/skill-freshness-update-dialog', () => ({
  requestSkillFreshnessUpdateDialog: vi.fn()
}))
vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))
vi.mock('./platform/web-client-location', () => ({ isWebClientLocation: () => false }))
vi.mock('../components/feature-tips/feature-tip-telemetry', () => ({
  trackChatUiFeatureTipExposure: vi.fn(),
  trackChatUiFeatureTipShown: vi.fn(),
  shouldSuppressAutomaticChatUiLaunchTip: () => false,
  trackCmdJPaletteFeatureTipShown: vi.fn(),
  trackOrcaCliFeatureTipShown: vi.fn()
}))

const completedOnboarding = {
  ...getDefaultOnboardingState(),
  closedAt: 1,
  outcome: 'completed' as const,
  lastCompletedStep: 4
}
const NUDGE = 'An installed Orca skill is out of date'

let releaseChunk: () => void = () => {}
let gate: ReturnType<typeof useOnboardingAndFeatureTips>
let openLocalDialog: (open: boolean) => void = () => {}

function ModalBody({ open }: { open: boolean }): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={() => useAppStore.setState({ activeModal: 'none' })}>
      <DialogContent>
        <DialogTitle>Loaded modal</DialogTitle>
        <DialogDescription>Opened from the store</DialogDescription>
      </DialogContent>
    </Dialog>
  )
}

// Fresh per test so the chunk is pending the first time the modal opens.
let LazyModal = lazyWithRetry(async () => ({ default: ModalBody }))

/** Mounted the way AppRootSurfaces mounts its lazy add-project modal. */
function LazyModalOwner(): React.JSX.Element | null {
  const { shouldMountAddRepoDialog } = useLazyModalMounts()
  const open = useAppStore((state) => state.activeModal === 'add-repo')
  return shouldMountAddRepoDialog ? (
    <Suspense fallback={null}>
      <LazyModal open={open} />
    </Suspense>
  ) : null
}

function LocalDialogOwner(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  openLocalDialog = setOpen
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle>Local dialog</DialogTitle>
        <DialogDescription>Owned by its component</DialogDescription>
      </DialogContent>
    </Dialog>
  )
}

function SshCredentialBody(): React.JSX.Element {
  return (
    <Dialog open>
      <DialogContent>
        <DialogTitle>Passphrase</DialogTitle>
        <DialogDescription>Unlock the SSH key</DialogDescription>
      </DialogContent>
    </Dialog>
  )
}

let releaseSshChunk: () => void = () => {}
let LazySshCredentialDialog = lazyWithRetry(async () => ({ default: SshCredentialBody }))

/** Mounted the way AppRootSurfaces mounts the SSH credential prompt: outside activeModal. */
function SshCredentialOwner(): React.JSX.Element | null {
  const pending = useAppStore((state) => state.sshCredentialQueue.length > 0)
  return pending ? (
    <Suspense fallback={null}>
      <LazySshCredentialDialog />
    </Suspense>
  ) : null
}

function App(): React.JSX.Element {
  gate = useOnboardingAndFeatureTips()
  return (
    <>
      <SkillFreshnessNudge startupPromptsFinished={gate.startupPromptsFinished} />
      <Toaster />
      <LazyModalOwner />
      <LocalDialogOwner />
      <SshCredentialOwner />
    </>
  )
}

let root: Root
let container: HTMLDivElement
let disposeOverlays: () => void

// One frame (deferred nudge creation, Sonner dismiss) then zero-delay tasks (Sonner delivery).
const settle = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(() => setTimeout(resolve, 0), 0)))
const step = async (change: () => void = () => {}): Promise<void> => {
  await act(async () => {
    change()
    await settle()
  })
}
// Toasts the user can see: a withheld copy is hidden until Sonner finishes removing it.
const visibleToasts = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('[data-sonner-toast]')].filter(
    (element) => element.style.display !== 'none'
  )
const nudge = (): Element | undefined =>
  visibleToasts().find((element) => element.textContent?.includes(NUDGE))
const raised = (): boolean => document.querySelector('[data-toasts-raised]') !== null

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  LazyModal = lazyWithRetry(
    () =>
      new Promise<{ default: typeof ModalBody }>((resolve) => {
        releaseChunk = () => resolve({ default: ModalBody })
      })
  )
  LazySshCredentialDialog = lazyWithRetry(
    () =>
      new Promise<{ default: typeof SshCredentialBody }>((resolve) => {
        releaseSshChunk = () => resolve({ default: SshCredentialBody })
      })
  )
  freshness.set(null)
  useAppStore.setState({
    activeModal: 'none',
    chatUiLaunchTipVariant: null,
    sshCredentialQueue: []
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      cli: { getInstallStatus: vi.fn().mockResolvedValue({ supported: false }) },
      onboarding: { getChatUiLaunchTipVariant: vi.fn().mockResolvedValue('none') }
    }
  })
  disposeOverlays = installBodyOverlayAttributes()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await step(() => root.render(<App />))
})

afterEach(async () => {
  await step(() => {
    toast.dismiss()
    root.unmount()
  })
  container.remove()
  disposeOverlays()
})

describe('new skill toast admission', () => {
  it('waits for a modal that is still loading after startup prompts were released', async () => {
    await step(() => gate.applyStartupOnboardingState(completedOnboarding))
    expect(gate.startupPromptsFinished).toBe(true)

    await step(() => useAppStore.getState().openModal('add-repo'))
    expect(document.body.hasAttribute('data-modal-overlay-open')).toBe(false)
    await step(() => freshness.set(planOf([sharedEntry('orca-cli', 'update')])))
    expect(nudge()).toBeUndefined()

    await step(() => releaseChunk())
    expect(document.body.hasAttribute('data-modal-overlay-open')).toBe(true)
    expect(nudge()).toBeUndefined()

    await step(() => useAppStore.setState({ activeModal: 'none' }))
    expect(nudge()).toBeDefined()
    expect(raised()).toBe(false)
  })

  it('waits for a modal that is still loading during startup', async () => {
    await step(() => {
      freshness.set(planOf([sharedEntry('orca-cli', 'update')]))
      useAppStore.getState().openModal('add-repo')
      gate.applyStartupOnboardingState(completedOnboarding)
    })
    expect(nudge()).toBeUndefined()
    await step(() => releaseChunk())
    expect(nudge()).toBeUndefined()

    await step(() => useAppStore.setState({ activeModal: 'none' }))
    expect(nudge()).toBeDefined()
  })

  it('keeps a delivered toast in place while a local dialog opens and closes', async () => {
    await step(() => gate.applyStartupOnboardingState(completedOnboarding))
    await step(() => freshness.set(planOf([sharedEntry('orca-cli', 'update')])))
    const delivered = nudge()
    expect(delivered).toBeDefined()

    await step(() => openLocalDialog(true))
    expect(raised()).toBe(false)
    expect(nudge()).toBe(delivered)

    await step(() => openLocalDialog(false))
    expect(nudge()).toBe(delivered)
    expect(visibleToasts()).toHaveLength(1)
  })

  it('waits for a queued SSH credential prompt that is still loading', async () => {
    await step(() => gate.applyStartupOnboardingState(completedOnboarding))
    await step(() =>
      useAppStore.setState({
        sshCredentialQueue: [
          { requestId: 'request-1', targetId: 'target-1', kind: 'passphrase', detail: 'key' }
        ]
      })
    )
    expect(document.body.hasAttribute('data-modal-overlay-open')).toBe(false)
    // An edited copy waits on the user, so this plan is never updated automatically.
    await step(() =>
      freshness.set(planOf([sharedEntry('orca-cli', 'leave', { reason: 'edited' })]))
    )
    expect(nudge()).toBeUndefined()

    await step(() => releaseSshChunk())
    expect(nudge()).toBeUndefined()

    await step(() => useAppStore.setState({ sshCredentialQueue: [] }))
    expect(nudge()).toBeDefined()
    expect(raised()).toBe(false)
  })

  it('withholds a toast whose modal opened after publication but before it was shown', async () => {
    await step(() => gate.applyStartupOnboardingState(completedOnboarding))
    const publish = toast.info
    const info = vi.spyOn(toast, 'info').mockImplementation((...args) => {
      const id = publish(...args)
      // A modal starts opening in the gap before Sonner delivers the toast.
      useAppStore.getState().openModal('add-repo')
      return id
    })
    await step(() => freshness.set(planOf([sharedEntry('orca-cli', 'update')])))
    // The nudge's creation frame was scheduled when that step's effects flushed.
    await step()
    expect(info).toHaveBeenCalledTimes(1)
    info.mockRestore()
    expect(nudge()).toBeUndefined()

    await step(() => useAppStore.setState({ activeModal: 'none' }))
    expect(nudge()).toBeDefined()
    expect(visibleToasts()).toHaveLength(1)
  })
})
