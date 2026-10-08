import { STARTUP_DISCOVERY_READ_TIMEOUT_MS } from '../startup/startup-discovery-read'
// @vitest-environment happy-dom

import { act, StrictMode, useEffect, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useDialogRegistry } from '@/store/dialog-registry'
import { selectDialogPhase } from '@/store/dialog-registry-state'
import { resetDialogRegistryForTests } from '@/store/dialog-registry-test-state'
import { getDefaultSettings } from '../../../shared/constants'
import type { CrashReportRecord } from '../../../shared/crash-reporting'
import { NativeChatResumeOnRestartModal } from '../components/NativeChatResumeOnRestartModal'
import { CrashReportDialog } from '../components/crash-report/CrashReportDialog'
import { AppOpenFeatureTip } from '../components/feature-tips/AppOpenFeatureTip'
import { APP_OPEN_FEATURE_TIP_TOKEN } from '../components/feature-tips/feature-tip-startup-gate'
import { SshPassphraseDialog } from '../components/settings/SshPassphraseDialog'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'
import { TooltipProvider } from '../components/ui/tooltip'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import type { ResumeCandidate } from '../components/native-chat-resume-on-restart-grouping'
import {
  _resetNativeChatRestartOffer,
  getNativeChatRestartOffer,
  useNativeChatRestartOffer
} from '../components/native-chat-resume-on-restart-store'
import {
  _resetNativeChatResumeOnRestartDialog,
  requestNativeChatResumeOnRestartDialog
} from '../components/native-chat-resume-on-restart-dialog'
import { resetLocalStructuredChatsForTests } from '@/runtime/local-structured-chats'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn(async () => true)
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
const surface = vi.hoisted(() => ({ loaded: Promise.resolve(), suspended: false, error: false }))
// The real surfaces have their own tests; here they are a real Dialog, so their entries behave.
vi.mock('../components/crash-report/CrashReportDialogSurface', async () => {
  const ui = await import('../components/ui/dialog')
  return {
    CrashReportDialogSurface: ({
      open,
      report,
      onOpenChange
    }: {
      open: boolean
      report: CrashReportRecord | null
      onOpenChange: (open: boolean) => void
    }) => {
      if (surface.error) {
        throw new Error('surface failed')
      }
      if (surface.suspended) {
        // Its lazy chunk is still loading: admitted, nothing on screen yet.
        throw surface.loaded
      }
      return (
        <ui.Dialog open={open} onOpenChange={onOpenChange}>
          <ui.DialogContent data-testid="crash-report" data-report={report?.id}>
            <ui.DialogTitle>Crash report</ui.DialogTitle>
            <textarea aria-label="notes" />
            <button type="button" onClick={() => onOpenChange(false)}>
              Close crash report
            </button>
          </ui.DialogContent>
        </ui.Dialog>
      )
    }
  }
})
vi.mock('../components/feature-tips/FeatureTipsModal', async () => {
  const ui = await import('../components/ui/dialog')
  return {
    FeatureTipDialogs: ({
      open,
      tipId,
      onClose
    }: {
      open: boolean
      tipId: string
      onClose: () => void
    }) => (
      <ui.Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <ui.DialogContent data-testid="feature-tip">
          <ui.DialogTitle>Tip {tipId}</ui.DialogTitle>
          <button type="button" onClick={onClose}>
            Close tip
          </button>
        </ui.DialogContent>
      </ui.Dialog>
    )
  }
})
const boundaryReports = vi.hoisted((): CrashReportRecord[] => [])
vi.mock('@/lib/react-error-boundary-reporting', () => ({
  REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT: 'test-boundary-report',
  takePendingReactErrorBoundaryReports: () => boundaryReports.splice(0),
  reportReactErrorBoundaryCrash: async () => {}
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

const offered: ResumeCandidate[] = [
  {
    sessionId: 'a',
    workspaceId: 'workspace',
    agent: 'codex',
    trigger: 'update',
    latestPrompt: 'Prompt a',
    recordedAt: 1_800_000_000_000,
    executionHostId: 'local',
    workspaceKind: 'git-worktree'
  }
]

function crash(id: string): CrashReportRecord {
  return {
    id,
    createdAt: '2026-10-05T00:00:00.000Z',
    status: 'pending',
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    appVersion: '1.0.0',
    platform: 'darwin',
    osRelease: 'test',
    arch: 'arm64',
    electronVersion: '1',
    chromeVersion: '1',
    details: {}
  }
}

const crashReports = {
  getLatestPending: vi.fn(async (): Promise<CrashReportRecord | null> => null),
  getLatestReport: vi.fn(async (): Promise<CrashReportRecord | null> => null),
  dismiss: vi.fn(async () => undefined)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  await flush()
}

/** What is on screen, top dialog last. */
function onScreen(): string[] {
  return [...document.querySelectorAll('[role="dialog"]')].map((dialog) => {
    const text = dialog.textContent ?? ''
    if (text.includes('Resume interrupted chats?')) {
      return 'resume'
    }
    if (dialog.getAttribute('data-testid') === 'crash-report') {
      return `crash:${dialog.getAttribute('data-report')}`
    }
    if (dialog.getAttribute('data-testid') === 'feature-tip') {
      return 'tip'
    }
    if (text.includes('SSH Key Passphrase')) {
      return 'ssh'
    }
    return dialog.querySelector('[data-slot="dialog-title"]')?.textContent ?? text
  })
}

function click(label: string): void {
  const found = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label
  )
  if (!found) {
    throw new Error(`Missing button: ${label}`)
  }
  act(() => found.click())
}

function closeTop(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

/** A modal-slot dialog as the app hosts it. */
function UserModal(): React.JSX.Element {
  const open = useAppStore((s) => s.activeModal === 'add-repo')
  return (
    <Dialog open={open}>
      <DialogContent>
        <DialogTitle>Add project</DialogTitle>
      </DialogContent>
    </Dialog>
  )
}

/** SSH is counted only when its content commits. */
function SshHost(): React.JSX.Element | null {
  const asked = useAppStore((s) => s.sshCredentialQueue.length > 0)
  return asked ? <SshPassphraseDialog /> : null
}

function Toggle({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    toggleOff = () => setShown(false)
  }, [])
  return shown ? <>{children}</> : null
}
let toggleOff: () => void = () => {}

function settleTip(answer: 'none' | 'unavailable' = 'none'): void {
  act(() => useDialogRegistry.getState().settleStartupSource('feature-tip', answer))
}

/** The startup decision is owned above the lazy tip surface. */
function DecidedTip(): React.JSX.Element {
  useLayoutEffect(() => {
    useDialogRegistry
      .getState()
      .settleStartupSource('feature-tip', 'ready', APP_OPEN_FEATURE_TIP_TOKEN)
  }, [])
  return <AppOpenFeatureTip tipId="orca-cli" />
}

function raiseSsh(): void {
  act(() =>
    useAppStore.getState().enqueueSshCredentialRequest({
      requestId: 'r1',
      targetId: 'host',
      kind: 'passphrase',
      detail: '~/.ssh/id_ed25519'
    })
  )
}

const everything = (
  <>
    <CrashReportDialog />
    <DecidedTip />
    <NativeChatResumeOnRestartModal />
  </>
)

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({ sessions: offered })
  crashReports.getLatestPending.mockReset().mockResolvedValue(null)
  crashReports.getLatestReport.mockReset().mockResolvedValue(null)
  crashReports.dismiss.mockReset().mockResolvedValue(undefined)
  _resetNativeChatRestartOffer()
  _resetNativeChatResumeOnRestartDialog()
  resetLocalStructuredChatsForTests()
  resetDialogRegistryForTests()
  surface.suspended = false
  surface.error = false
  boundaryReports.length = 0
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalStructuredNativeChat: true }
  })
  Object.assign(window, {
    api: {
      crashReports,
      ui: { onOpenCrashReport: () => () => {}, set: vi.fn(async () => undefined) },
      ssh: { submitCredential: vi.fn(async () => undefined) },
      gh: { viewer: vi.fn(async () => null) },
      app: {
        holdsStructuredAgentSessions: vi.fn(async () => false),
        onStructuredAgentSessionsHeldChanged: () => () => {}
      }
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
  _resetNativeChatRestartOffer()
  _resetNativeChatResumeOnRestartDialog()
})

it('shows the crash report, then the tip, then the resume offer, one at a time', async () => {
  crashReports.getLatestPending.mockResolvedValue(crash('c1'))
  await mount(everything)
  expect(onScreen()).toEqual(['crash:c1'])
  click('Close crash report')
  await flush()
  expect(onScreen()).toEqual(['tip'])
  click('Close tip')
  await flush()
  expect(onScreen()).toEqual(['resume'])
})

it('a fast resume read waits for a slow crash check, whose report goes first', async () => {
  const pending = Promise.withResolvers<CrashReportRecord | null>()
  crashReports.getLatestPending.mockReturnValue(pending.promise)
  settleTip()
  await mount(
    <>
      <CrashReportDialog />
      <NativeChatResumeOnRestartModal />
    </>
  )
  expect(onScreen()).toEqual([])
  await act(async () => pending.resolve(crash('c1')))
  await flush()
  expect(onScreen()).toEqual(['crash:c1'])
  click('Close crash report')
  await flush()
  expect(onScreen()).toEqual(['resume'])
})

it('a fast resume read waits for the tip check, then shows once it has answered', async () => {
  await mount(
    <>
      <CrashReportDialog />
      <NativeChatResumeOnRestartModal />
    </>
  )
  expect(onScreen()).toEqual([])
  settleTip()
  await flush()
  expect(onScreen()).toEqual(['resume'])
})

it('a crash check that fails answers unavailable, so later dialogs still show', async () => {
  crashReports.getLatestPending.mockRejectedValue(new Error('ipc down'))
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  await mount(everything)
  expect(useDialogRegistry.getState().startupSources['crash-report']).toBe('unavailable')
  expect(onScreen()).toEqual(['tip'])
  consoleError.mockRestore()
})

it('each crash report takes its own turn, and the same report shows once', async () => {
  settleTip()
  await mount(<CrashReportDialog />)
  act(() => {
    boundaryReports.push(crash('b1'), crash('b2'))
    window.dispatchEvent(new Event('test-boundary-report'))
  })
  await flush()
  expect(onScreen()).toEqual(['crash:b1'])
  act(() => {
    boundaryReports.push(crash('b1'))
    window.dispatchEvent(new Event('test-boundary-report'))
  })
  await flush()
  click('Close crash report')
  await flush()
  expect(onScreen()).toEqual(['crash:b2'])
  click('Close crash report')
  await flush()
  expect(onScreen()).toEqual([])
  act(() => {
    boundaryReports.push(crash('b1'))
    window.dispatchEvent(new Event('test-boundary-report'))
  })
  await flush()
  expect(onScreen()).toEqual([])
})

it.each([
  ['crash:c1', 'tip'],
  ['tip', 'resume'],
  ['resume', null]
] as const)(
  'a user dialog stacks over a shown %s, which stays as it was; the next waits for both',
  async (shown, next) => {
    crashReports.getLatestPending.mockResolvedValue(shown === 'crash:c1' ? crash('c1') : null)
    await mount(
      <>
        {shown === 'resume' ? null : <DecidedTip />}
        <CrashReportDialog />
        <NativeChatResumeOnRestartModal />
        <UserModal />
      </>
    )
    if (shown === 'resume') {
      settleTip()
      await flush()
    }
    expect(onScreen()).toEqual([shown])
    const element = document.querySelector('[role="dialog"]')
    act(() => useAppStore.getState().openModal('add-repo'))
    await flush()
    expect(onScreen()).toEqual([shown, 'Add project'])
    expect(document.querySelector('[role="dialog"]')).toBe(element)

    act(() => useAppStore.getState().closeModal())
    await flush()
    expect(onScreen()).toEqual([shown])
    expect(document.querySelector('[role="dialog"]')).toBe(element)
    closeTop()
    await flush()
    expect(onScreen()).toEqual(next ? [next] : [])
  }
)

it('an SSH prompt shows at once, before any startup check has answered', async () => {
  crashReports.getLatestPending.mockReturnValue(new Promise(() => {}))
  await mount(
    <>
      {everything}
      <SshHost />
    </>
  )
  raiseSsh()
  await flush()
  expect(onScreen()).toEqual(['ssh'])
})

it('an SSH prompt stacks over a shown resume offer, which stays as it was', async () => {
  settleTip()
  await mount(
    <>
      <CrashReportDialog />
      <NativeChatResumeOnRestartModal />
      <SshHost />
    </>
  )
  const offer = document.querySelector('[role="dialog"]')
  raiseSsh()
  await flush()
  expect(onScreen()).toEqual(['resume', 'ssh'])
  await act(async () => useAppStore.getState().removeSshCredentialRequest('r1'))
  await flush()
  expect(onScreen()).toEqual(['resume'])
  expect(document.querySelector('[role="dialog"]')).toBe(offer)
})

it('an owner going away withdraws its dialog, and the next one shows', async () => {
  crashReports.getLatestPending.mockResolvedValue(crash('c1'))
  settleTip()
  await mount(
    <>
      <Toggle>
        <CrashReportDialog />
      </Toggle>
      <NativeChatResumeOnRestartModal />
    </>
  )
  expect(onScreen()).toEqual(['crash:c1'])
  act(() => toggleOff())
  await flush()
  expect(onScreen()).toEqual(['resume'])
})

it('a modal that fails to render ends only its own entry', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const Thrower = (): null => {
    throw new Error('composer render bug')
  }
  const [other, setOther] = [{ open: true }, (open: boolean) => (other.open = open)]
  function OtherDialog(): React.JSX.Element {
    const [open, setOpen] = useState(other.open)
    useEffect(() => {
      closeOther = () => {
        setOther(false)
        setOpen(false)
      }
    }, [])
    return (
      <Dialog open={open}>
        <DialogContent>
          <DialogTitle>Other</DialogTitle>
        </DialogContent>
      </Dialog>
    )
  }
  settleTip()
  act(() => useAppStore.getState().openModal('new-workspace-composer'))
  crashReports.getLatestPending.mockResolvedValue(crash('c1'))
  await mount(
    <>
      <RecoverableRenderErrorBoundary boundaryId="modal.composer" surface="modal" compact>
        <Thrower />
      </RecoverableRenderErrorBoundary>
      <OtherDialog />
      <CrashReportDialog />
    </>
  )
  // The failed modal's entry is gone, while the slot is still set; the other dialog still holds.
  expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
  expect(onScreen()).toEqual(['Other'])
  act(() => closeOther())
  await flush()
  expect(onScreen()).toEqual(['crash:c1'])
  consoleError.mockRestore()
})
let closeOther: () => void = () => {}

it('the user opening the resume offer shows it at once, and the launch offer never repeats it', async () => {
  crashReports.getLatestPending.mockResolvedValue(crash('c1'))
  rpc.mockResolvedValue({ sessions: [] })
  settleTip()
  await mount(
    <>
      <CrashReportDialog />
      <NativeChatResumeOnRestartModal />
    </>
  )
  expect(onScreen()).toEqual(['crash:c1'])
  rpc.mockResolvedValue({ sessions: offered })
  await act(async () => {
    // As the status bar does: re-read, then ask.
    await import('../components/native-chat-resume-on-restart-store').then((store) =>
      store.refreshNativeChatRestartOffer()
    )
    requestNativeChatResumeOnRestartDialog('user')
  })
  await flush()
  expect(onScreen()).toEqual(['crash:c1', 'resume'])
  closeTop()
  await flush()
  act(() => requestNativeChatResumeOnRestartDialog('launch'))
  await flush()
  click('Close crash report')
  await flush()
  // The user has already seen and closed it; the launch's own ask does not bring it back.
  expect(onScreen()).toEqual([])
})

it('a tip decided while a user modal is up keeps its place ahead of a queued resume offer', async () => {
  act(() => useAppStore.getState().openModal('add-repo'))
  await mount(
    <>
      <CrashReportDialog />
      <NativeChatResumeOnRestartModal />
      <UserModal />
    </>
  )
  // The resume offer is read and queued; the tip is decided after it.
  await mount(
    <>
      <CrashReportDialog />
      <NativeChatResumeOnRestartModal />
      <UserModal />
      <DecidedTip />
    </>
  )
  expect(onScreen()).toEqual(['Add project'])
  act(() => useAppStore.getState().closeModal())
  await flush()
  expect(onScreen()).toEqual(['tip'])
  click('Close tip')
  await flush()
  expect(onScreen()).toEqual(['resume'])
})

it('acknowledges a launch crash report only once its content is on screen', async () => {
  const load = Promise.withResolvers<void>()
  surface.loaded = load.promise
  surface.suspended = true
  crashReports.getLatestPending.mockResolvedValue(crash('c1'))
  await mount(<CrashReportDialog />)
  expect(useDialogRegistry.getState().dialogEntries).toEqual([
    expect.objectContaining({ token: 'crash-report:c1' })
  ])
  expect(selectDialogPhase(useDialogRegistry.getState(), 'crash-report:c1')).toBe('opening')
  expect(crashReports.dismiss).not.toHaveBeenCalled()
  surface.suspended = false
  await act(async () => load.resolve())
  await flush()
  expect(onScreen()).toEqual(['crash:c1'])
  expect(crashReports.dismiss).toHaveBeenCalledWith({ reportId: 'c1' })
})

it('marks the tip seen only once it is on screen', async () => {
  const markFeatureTipsSeen = vi.fn()
  useAppStore.setState({ markFeatureTipsSeen })
  act(() => useAppStore.getState().openModal('add-repo'))
  await mount(
    <>
      <CrashReportDialog />
      <UserModal />
      <DecidedTip />
    </>
  )
  expect(markFeatureTipsSeen).not.toHaveBeenCalled()
  act(() => useAppStore.getState().closeModal())
  await flush()
  expect(onScreen()).toEqual(['tip'])
  expect(markFeatureTipsSeen).toHaveBeenCalledWith(['orca-cli'])
})

it.each(['user modal', 'SSH prompt'] as const)(
  'a %s opened while an admitted crash report is still loading stays on top; the report waits for it',
  async (opened) => {
    const load = Promise.withResolvers<void>()
    surface.loaded = load.promise
    surface.suspended = true
    settleTip()
    crashReports.getLatestPending.mockResolvedValue(crash('c1'))
    await mount(
      <>
        <CrashReportDialog />
        <UserModal />
        <SshHost />
      </>
    )
    expect(onScreen()).toEqual([])
    if (opened === 'user modal') {
      act(() => useAppStore.getState().openModal('add-repo'))
    } else {
      raiseSsh()
    }
    await flush()
    surface.suspended = false
    await act(async () => load.resolve())
    await flush()
    const top = opened === 'user modal' ? 'Add project' : 'ssh'
    expect(onScreen()).toEqual([top])
    expect(document.querySelector('[data-testid="crash-report"]')).toBeNull()

    if (opened === 'user modal') {
      act(() => useAppStore.getState().closeModal())
    } else {
      await act(async () => useAppStore.getState().removeSshCredentialRequest('r1'))
    }
    await flush()
    expect(onScreen()).toEqual(['crash:c1'])
  }
)

it('in StrictMode (dev builds) a tip decided after the resume offer was queued still goes first', async () => {
  act(() => useDialogRegistry.getState().settleStartupSource('crash-report', 'none'))
  await mount(
    <StrictMode>
      <NativeChatResumeOnRestartModal />
    </StrictMode>
  )
  expect(onScreen()).toEqual([])
  await mount(
    <StrictMode>
      <NativeChatResumeOnRestartModal />
      <DecidedTip />
    </StrictMode>
  )
  expect(onScreen()).toEqual(['tip'])
  click('Close tip')
  await flush()
  expect(onScreen()).toEqual(['resume'])
})

it('a never-answering crash read releases the startup order and ignores its late answer', async () => {
  const pending = Promise.withResolvers<CrashReportRecord | null>()
  crashReports.getLatestPending.mockReturnValue(pending.promise)
  settleTip()
  vi.useFakeTimers()
  try {
    await act(async () => root.render(<CrashReportDialog />))
    await act(async () => vi.advanceTimersByTimeAsync(STARTUP_DISCOVERY_READ_TIMEOUT_MS))
    expect(useDialogRegistry.getState().startupSources['crash-report']).toBe('unavailable')
    await act(async () => pending.resolve(crash('late')))
    expect(useDialogRegistry.getState().dialogEntries).toEqual([])
    expect(crashReports.dismiss).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('failed automatic content releases only its own token, leaving another dialog untouched', async () => {
  const silent = vi.spyOn(console, 'error').mockImplementation(() => {})
  const load = Promise.withResolvers<void>()
  surface.loaded = load.promise
  surface.suspended = true
  settleTip()
  crashReports.getLatestPending.mockResolvedValue(crash('broken'))
  await mount(
    <>
      <CrashReportDialog />
      <UserModal />
    </>
  )
  surface.suspended = false
  surface.error = true
  await act(async () => load.resolve())
  await flush()
  expect(useDialogRegistry.getState().dialogEntries).toEqual([])
  expect(crashReports.dismiss).not.toHaveBeenCalled()
  act(() => useAppStore.getState().openModal('add-repo'))
  await flush()
  expect(onScreen()).toEqual(['Add project'])
  expect(useDialogRegistry.getState().dialogEntries).toHaveLength(1)
  silent.mockRestore()
})

it.each(['settings unavailable', 'held read hung', 'offer read hung'] as const)(
  'the resume startup discovery ends when %s, without delaying earlier kinds',
  async (failure) => {
    if (failure !== 'offer read hung') {
      useAppStore.setState({
        settings: failure === 'settings unavailable' ? null : getDefaultSettings(''),
        persistedUIReady: true
      })
    }
    window.api.app.holdsStructuredAgentSessions = () => new Promise(() => {})
    rpc.mockReturnValue(new Promise(() => {}))
    vi.useFakeTimers()
    try {
      await act(async () => root.render(<NativeChatResumeOnRestartModal />))
      await act(async () => vi.advanceTimersByTimeAsync(STARTUP_DISCOVERY_READ_TIMEOUT_MS))
      expect(useDialogRegistry.getState().startupSources['native-chat-resume']).toBe('unavailable')
    } finally {
      vi.useRealTimers()
    }
  }
)

function OfferDataSubscriber(): null {
  useNativeChatRestartOffer(true)
  return null
}

it.each([false, true])(
  'a held runtime keeps the owner recovery read enabled with missing settings and hydration %s',
  async (persistedUIReady) => {
    useAppStore.setState({ settings: null, persistedUIReady })
    window.api.app.holdsStructuredAgentSessions = async () => true
    act(() => useDialogRegistry.getState().settleStartupSource('crash-report', 'none'))
    settleTip()
    await mount(<NativeChatResumeOnRestartModal />)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(getNativeChatRestartOffer().candidates).toEqual(offered)
    expect(onScreen()).toEqual(['resume'])
    expect(useDialogRegistry.getState().startupSources['native-chat-resume']).toBe(
      persistedUIReady ? 'unavailable' : 'pending'
    )
  }
)

it('an ordinary offer subscriber cannot answer or abandon startup discovery', async () => {
  const read = Promise.withResolvers<{ sessions: ResumeCandidate[] }>()
  rpc.mockReturnValue(read.promise)
  await mount(<OfferDataSubscriber />)
  await act(async () => root.render(null))
  expect(useDialogRegistry.getState().startupSources['native-chat-resume']).toBe('pending')
  await act(async () => read.resolve({ sessions: offered }))
  expect(getNativeChatRestartOffer().candidates).toEqual(offered)
  expect(useDialogRegistry.getState().startupSources['native-chat-resume']).toBe('pending')
  expect(useDialogRegistry.getState().dialogEntries).toEqual([])
})

it('losing the resume owner abandons discovery while its data subscriber keeps recovery', async () => {
  const read = Promise.withResolvers<{ sessions: ResumeCandidate[] }>()
  rpc.mockReturnValue(read.promise)
  await mount(
    <>
      <Toggle>
        <NativeChatResumeOnRestartModal />
      </Toggle>
      <OfferDataSubscriber />
    </>
  )
  act(() => toggleOff())
  await flush()
  expect(useDialogRegistry.getState().startupSources['native-chat-resume']).toBe('unavailable')
  await act(async () => read.resolve({ sessions: offered }))
  await flush()
  expect(getNativeChatRestartOffer().candidates).toEqual(offered)
  expect(useDialogRegistry.getState().dialogEntries).toEqual([])
})

it.each([false, true])('a disabled offer waits for an actual held answer of %s', async (holds) => {
  const held = Promise.withResolvers<boolean>()
  useAppStore.setState({ settings: getDefaultSettings('') })
  window.api.app.holdsStructuredAgentSessions = () => held.promise
  await mount(<NativeChatResumeOnRestartModal />)
  expect(useDialogRegistry.getState().startupSources['native-chat-resume']).toBe('pending')
  expect(rpc).not.toHaveBeenCalled()
  const answers: string[][] = []
  const unsubscribe = useDialogRegistry.subscribe((state) => {
    if (state.startupSources['native-chat-resume'] === 'ready') {
      answers.push(state.dialogEntries.map((entry) => entry.token))
    }
  })
  await act(async () => held.resolve(holds))
  await flush()
  unsubscribe()
  expect(useDialogRegistry.getState().startupSources['native-chat-resume']).toBe(
    holds ? 'ready' : 'none'
  )
  expect(rpc).toHaveBeenCalledTimes(holds ? 1 : 0)
  if (holds) {
    expect(answers.length).toBeGreaterThan(0)
    expect(answers.every((tokens) => tokens.includes('native-chat-resume'))).toBe(true)
  }
})

it('an offer arriving after the discovery deadline still recovers and can be shown', async () => {
  const read = Promise.withResolvers<{ sessions: ResumeCandidate[] }>()
  rpc.mockReturnValue(read.promise)
  act(() => useDialogRegistry.getState().settleStartupSource('crash-report', 'none'))
  settleTip()
  vi.useFakeTimers()
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <NativeChatResumeOnRestartModal />
        </TooltipProvider>
      )
    )
    await act(async () => vi.advanceTimersByTimeAsync(STARTUP_DISCOVERY_READ_TIMEOUT_MS))
    expect(useDialogRegistry.getState().startupSources['native-chat-resume']).toBe('unavailable')
    await act(async () => read.resolve({ sessions: offered }))
    expect(getNativeChatRestartOffer().candidates).toEqual(offered)
    expect(onScreen()).toEqual(['resume'])
    expect(useDialogRegistry.getState().startupSources['native-chat-resume']).toBe('unavailable')
  } finally {
    vi.useRealTimers()
  }
})

it('a failed launch acknowledgement is attempted once in StrictMode and never belongs to runtime reports', async () => {
  const silent = vi.spyOn(console, 'error').mockImplementation(() => {})
  crashReports.getLatestPending.mockResolvedValue(crash('launch'))
  crashReports.dismiss.mockRejectedValue(new Error('write failed'))
  boundaryReports.push(crash('runtime'))
  try {
    await mount(
      <StrictMode>
        <CrashReportDialog />
      </StrictMode>
    )
    expect(onScreen()).toEqual(['crash:runtime'])
    expect(crashReports.dismiss).not.toHaveBeenCalled()
    click('Close crash report')
    await flush()
    expect(onScreen()).toEqual(['crash:launch'])
    expect(crashReports.dismiss).toHaveBeenCalledExactlyOnceWith({ reportId: 'launch' })
    click('Close crash report')
    await flush()
    expect(onScreen()).toEqual([])
    expect(crashReports.dismiss).toHaveBeenCalledTimes(1)
  } finally {
    silent.mockRestore()
  }
})
