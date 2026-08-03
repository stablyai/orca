// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinuxPackageInstallRecovery } from '../../../shared/types'
import { LinuxPackageInstallRecoveryCard } from './LinuxPackageInstallRecoveryCard'

const RELEASE_URL = 'https://github.com/stablyai/orca/releases/tag/v1.4.200'
const DIAGNOSTIC = 'pkexec: no polkit authentication agent found'
const INSTALL_COMMAND = 'sudo apt-get install -y /tmp/orca-updates/orca_1.4.200_amd64.deb'
const PACKAGE_FILE_NAME = 'orca_1.4.200_amd64.deb'
const SUMMARY = 'Orca downloaded the update but could not install the system package automatically.'
const COPIED_NOTE =
  `Command copied. Run it in a system terminal to install ${PACKAGE_FILE_NAME}, ` +
  'then quit and reopen Orca.'
const INSTRUCTIONS = {
  ok: true as const,
  command: INSTALL_COMMAND,
  packageFileName: PACKAGE_FILE_NAME
}
const NO_PACKAGE_MANAGER = {
  ok: false as const,
  reason: 'no-package-manager' as const,
  message: 'No supported package manager was found.'
}

const getInstructions = vi.fn()
const showLinuxPackage = vi.fn()
const quitAndInstall = vi.fn()
const writeClipboardText = vi.fn()
const openUrl = vi.fn()
const onClose = vi.fn()
const allMocks = [
  getInstructions,
  showLinuxPackage,
  quitAndInstall,
  writeClipboardText,
  openUrl,
  onClose
]

function makeRecovery(
  overrides: Partial<LinuxPackageInstallRecovery> = {}
): LinuxPackageInstallRecovery {
  return {
    kind: 'linux-package-install',
    packageType: 'deb',
    reason: 'package-install-failed',
    version: '1.4.200',
    ...overrides
  }
}

type CardOptions = { recovery?: LinuxPackageInstallRecovery; diagnostic?: string }

function cardElement(options: CardOptions = {}): React.ReactElement {
  return (
    <LinuxPackageInstallRecoveryCard
      recovery={options.recovery ?? makeRecovery()}
      diagnostic={options.diagnostic ?? DIAGNOSTIC}
      releaseUrl={RELEASE_URL}
      onClose={onClose}
    />
  )
}

function renderCard(options: CardOptions = {}): RenderResult {
  return render(cardElement(options))
}

/**
 * Main force-sends a new recovery object on every attempt, which re-renders this card rather than
 * remounting it. That push is the only signal a retry failed — quitAndInstall already resolved.
 */
function pushFreshRecovery(view: RenderResult, options: CardOptions = {}): void {
  view.rerender(cardElement({ ...options, recovery: makeRecovery(options.recovery) }))
}

// Why: each action chains several promises; drain them without depending on timer faking.
async function flushActions(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve()
    }
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function button(name: string): HTMLElement {
  return screen.getByRole('button', { name })
}

/** The card marks busy actions with aria-disabled so pressed buttons keep focus. */
function isAriaDisabled(element: HTMLElement): boolean {
  return element.getAttribute('aria-disabled') === 'true'
}

/**
 * Trailing <p> of the actions column. It owns no live-region role of its own — the surrounding
 * update Card is already aria-live, and nesting one inside another duplicates announcements.
 */
function footnoteElement(): HTMLElement | null {
  const cardRoot = document.body.firstElementChild?.firstElementChild
  const last = cardRoot?.lastElementChild?.lastElementChild
  return last?.tagName === 'P' ? (last as HTMLElement) : null
}

function footnoteText(): string | null {
  return footnoteElement()?.textContent ?? null
}

beforeEach(() => {
  allMocks.forEach((mock) => mock.mockReset())
  getInstructions.mockResolvedValue(INSTRUCTIONS)
  showLinuxPackage.mockResolvedValue(undefined)
  quitAndInstall.mockResolvedValue(undefined)
  writeClipboardText.mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      shell: { openUrl },
      ui: { writeClipboardText },
      updater: {
        getLinuxPackageInstallInstructions: getInstructions,
        showLinuxPackage,
        quitAndInstall
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('LinuxPackageInstallRecoveryCard copy', () => {
  it('leads with the recovery copy and the three dedicated actions', () => {
    renderCard()

    expect(screen.getByText('Automatic Install Failed')).toBeTruthy()
    expect(screen.getByText(SUMMARY)).toBeTruthy()
    expect(
      screen.getByText(/a system terminal on the computer where Orca is installed/)
    ).toBeTruthy()
    expect(screen.getByText(/quit and reopen Orca to run the new version/)).toBeTruthy()

    expect(button('Copy Install Command')).toBeTruthy()
    expect(button('Try Automatic Install Again')).toBeTruthy()
    expect(button('Show Package')).toBeTruthy()
  })

  it('never offers the generic Retry Download action', () => {
    renderCard()

    expect(screen.queryByRole('button', { name: 'Retry Download' })).toBeNull()
    // The release fallback only appears once no command can be built.
    expect(screen.queryByRole('button', { name: 'Download Manually' })).toBeNull()
  })

  it('minimizes to the status bar from the header control', () => {
    renderCard()

    fireEvent.click(button('Minimize to status bar'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('LinuxPackageInstallRecoveryCard copy action', () => {
  it('writes the main-generated command to the clipboard and confirms it', async () => {
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    expect(getInstructions).toHaveBeenCalledTimes(1)
    expect(writeClipboardText).toHaveBeenCalledWith(INSTALL_COMMAND)
    // The confirmation names the artifact and never replaces the button's own label.
    expect(footnoteText()).toBe(COPIED_NOTE)
    expect(footnoteText()).toContain(PACKAGE_FILE_NAME)
    expect(button('Copy Install Command')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Command copied' })).toBeNull()
  })

  it('announces through the card, not a nested live region', async () => {
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    expect(footnoteText()).toBe(COPIED_NOTE)
    expect(footnoteElement()?.hasAttribute('role')).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('clears the confirmation when another action starts', async () => {
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()
    expect(footnoteText()).toBe(COPIED_NOTE)

    fireEvent.click(button('Show Package'))
    await flushActions()

    expect(footnoteElement()).toBeNull()
  })

  it('clears the confirmation when the automatic install is retried', async () => {
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()
    expect(footnoteText()).toBe(COPIED_NOTE)

    fireEvent.click(button('Try Automatic Install Again'))
    await flushActions()

    expect(quitAndInstall).toHaveBeenCalledTimes(1)
    expect(footnoteElement()).toBeNull()
  })

  it('retires the copy confirmation after the transient window', async () => {
    // Why: happy-dom's window timers escape Vitest's fake clock, so capture the scheduled callback.
    const scheduled: { handler: () => void; delay?: number }[] = []
    vi.spyOn(window, 'setTimeout').mockImplementation(((handler: () => void, delay?: number) => {
      scheduled.push({ handler, delay })
      return scheduled.length
    }) as unknown as typeof window.setTimeout)
    vi.spyOn(window, 'clearTimeout').mockImplementation(() => undefined)
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()
    expect(footnoteText()).toBe(COPIED_NOTE)

    const expiry = scheduled.find((entry) => entry.delay === 4_000)
    expect(expiry).toBeTruthy()
    act(() => expiry?.handler())

    expect(footnoteElement()).toBeNull()
    expect(button('Copy Install Command')).toBeTruthy()
  })

  it('keeps the copy path when the instruction call rejects', async () => {
    getInstructions.mockRejectedValue(
      new Error(
        "Error invoking remote method 'updater:getLinuxPackageInstallInstructions': " +
          'Error: Unauthorized updater package recovery sender'
      )
    )
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    // Why: the Electron channel prefix must be stripped before the user sees the message.
    expect(footnoteText()).toBe('Unauthorized updater package recovery sender')
    expect(footnoteElement()?.className).toContain('text-destructive')
    // Why: only main can rule out a command; a rejection must not push the 160 MB redownload.
    expect(button('Copy Install Command').dataset.variant).toBe('default')
    expect(screen.getByText(/Copy the command and run it/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Download Manually' })).toBeNull()
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('keeps the copy path when the artifact fails revalidation', async () => {
    getInstructions.mockRejectedValue(
      new Error('Error: The downloaded package no longer matches the verified release.')
    )
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    expect(footnoteText()).toBe('The downloaded package no longer matches the verified release.')
    expect(screen.getByText('Automatic Install Failed')).toBeTruthy()
    expect(button('Copy Install Command').dataset.variant).toBe('default')
    expect(button('Show Package').dataset.variant).toBe('link')
  })

  it('retries the instruction call after a rejection', async () => {
    getInstructions.mockRejectedValueOnce(new Error('Unauthorized updater package recovery sender'))
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    expect(getInstructions).toHaveBeenCalledTimes(2)
    expect(footnoteText()).toBe(COPIED_NOTE)
  })

  it('keeps the copy path when only the clipboard write fails', async () => {
    writeClipboardText.mockRejectedValue(new Error('Clipboard is unavailable.'))
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    expect(footnoteText()).toBe('Clipboard is unavailable.')
    expect(screen.queryByText(COPIED_NOTE)).toBeNull()
    // Why: the command was built and validated — only the clipboard failed, so nothing is demoted.
    const copyButton = button('Copy Install Command')
    expect(copyButton.dataset.variant).toBe('default')
    expect(isAriaDisabled(copyButton)).toBe(false)
    expect(button('Show Package').dataset.variant).toBe('link')
    expect(screen.getByText(/Copy the command and run it/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Download Manually' })).toBeNull()
  })

  it('recovers from a clipboard failure on the next copy attempt', async () => {
    writeClipboardText.mockRejectedValueOnce(new Error('Clipboard is unavailable.'))
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    expect(writeClipboardText).toHaveBeenCalledTimes(2)
    expect(footnoteText()).toBe(COPIED_NOTE)
  })
})

describe('LinuxPackageInstallRecoveryCard hashing state', () => {
  it('names the work and blocks parallel jobs from repeated clicks', async () => {
    const pending = deferred<typeof INSTRUCTIONS>()
    getInstructions.mockReturnValue(pending.promise)
    renderCard()

    fireEvent.click(button('Copy Install Command'))

    const checking = button('Checking package...')
    expect(isAriaDisabled(checking)).toBe(true)
    expect(isAriaDisabled(button('Show Package'))).toBe(true)
    expect(isAriaDisabled(button('Try Automatic Install Again'))).toBe(true)

    fireEvent.click(checking)
    fireEvent.click(button('Show Package'))
    fireEvent.click(button('Try Automatic Install Again'))

    // Why: the buttons stay clickable for focus reasons, so the handlers must do the refusing.
    expect(getInstructions).toHaveBeenCalledTimes(1)
    expect(showLinuxPackage).not.toHaveBeenCalled()
    expect(quitAndInstall).not.toHaveBeenCalled()

    pending.resolve(INSTRUCTIONS)
    await flushActions()

    expect(footnoteText()).toBe(COPIED_NOTE)
    expect(isAriaDisabled(button('Show Package'))).toBe(false)
  })

  it('dims busy actions instead of relying on the native disabled styling', () => {
    const pending = deferred<typeof INSTRUCTIONS>()
    getInstructions.mockReturnValue(pending.promise)
    renderCard()

    fireEvent.click(button('Copy Install Command'))

    // Why: ui/button styles only `disabled:`, so without these an inert action looks fully live.
    for (const name of ['Checking package...', 'Try Automatic Install Again', 'Show Package']) {
      expect(button(name).className).toContain('aria-disabled:opacity-50')
      expect(button(name).className).toContain('aria-disabled:cursor-default')
    }

    pending.resolve(INSTRUCTIONS)
  })

  it('keeps focus on the pressed action while it hashes', () => {
    const pending = deferred<typeof INSTRUCTIONS>()
    getInstructions.mockReturnValue(pending.promise)
    renderCard()

    const copyButton = button('Copy Install Command')
    copyButton.focus()
    fireEvent.click(copyButton)

    // Why: a native `disabled` here would blur the button and dump focus to <body>.
    expect(document.activeElement).toBe(button('Checking package...'))
    expect(document.activeElement).not.toBe(document.body)

    pending.resolve(INSTRUCTIONS)
  })

  it('names the work while revealing the package and re-enables afterwards', async () => {
    const pending = deferred<void>()
    showLinuxPackage.mockReturnValue(pending.promise)
    renderCard()

    fireEvent.click(button('Show Package'))

    expect(button('Checking package...')).toBeTruthy()
    expect(isAriaDisabled(button('Copy Install Command'))).toBe(true)

    pending.resolve()
    await flushActions()

    expect(showLinuxPackage).toHaveBeenCalledTimes(1)
    expect(isAriaDisabled(button('Copy Install Command'))).toBe(false)
  })
})

describe('LinuxPackageInstallRecoveryCard details', () => {
  it('adds the neutral no-agent note for authentication-agent-unavailable', () => {
    renderCard({ recovery: makeRecovery({ reason: 'authentication-agent-unavailable' }) })

    expect(screen.queryByText(/No usable authentication agent/)).toBeNull()

    const disclosure = button('Show details')
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(disclosure)

    const detail = screen.getByText(/No usable authentication agent answered/)
    expect(detail.textContent).toContain(DIAGNOSTIC)
    expect(button('Hide details').getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(button('Hide details'))
    expect(screen.queryByText(/No usable authentication agent/)).toBeNull()
    expect(button('Show details').getAttribute('aria-expanded')).toBe('false')
  })

  it('scopes the trust note to the moment the command is built', () => {
    renderCard()

    fireEvent.click(button('Show details'))

    // Why: the digest check is a point-in-time claim, not a standing guarantee about the file.
    const detail = screen.getByText(/Orca checks the downloaded file against the release metadata/)
    expect(detail.textContent).toContain('at the moment it builds this command')
    expect(detail.textContent).toContain(
      'The system package itself is not signature-checked, and Orca cannot vouch for the file ' +
        'after that point.'
    )
  })

  it('omits the no-agent note for other failure reasons', () => {
    renderCard({ recovery: makeRecovery({ reason: 'authentication-denied' }) })

    fireEvent.click(button('Show details'))

    expect(screen.queryByText(/No usable authentication agent/)).toBeNull()
    expect(screen.getByText(new RegExp(DIAGNOSTIC))).toBeTruthy()
  })

  it('scrolls long diagnostics instead of widening the card', () => {
    const long = `${DIAGNOSTIC} ${'diagnostic-overflow '.repeat(400)}`
    const { container } = renderCard({ diagnostic: long })

    fireEvent.click(button('Show details'))

    const detail = container.querySelector('p.font-mono')
    expect(detail?.className).toContain('max-h-20')
    expect(detail?.className).toContain('overflow-auto')
    expect(detail?.className).toContain('break-words')
    expect(detail?.textContent).toContain('diagnostic-overflow')
  })
})

describe('LinuxPackageInstallRecoveryCard retry', () => {
  it('retries the automatic install through quitAndInstall', () => {
    renderCard()

    fireEvent.click(button('Try Automatic Install Again'))

    expect(quitAndInstall).toHaveBeenCalledTimes(1)
    expect(getInstructions).not.toHaveBeenCalled()
  })

  it('holds the busy slot while the quit is in flight', async () => {
    renderCard()

    fireEvent.click(button('Try Automatic Install Again'))
    await flushActions()

    // Why: quitAndInstall resolves as soon as main schedules the install, so a resolved promise is
    // not an outcome — the slot stays held until a real status arrives.
    expect(isAriaDisabled(button('Copy Install Command'))).toBe(true)
    expect(isAriaDisabled(button('Show Package'))).toBe(true)

    fireEvent.click(button('Copy Install Command'))
    fireEvent.click(button('Show Package'))
    await flushActions()

    expect(getInstructions).not.toHaveBeenCalled()
    expect(showLinuxPackage).not.toHaveBeenCalled()
    expect(quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('releases the busy slot when a fresh recovery status arrives', async () => {
    const view = renderCard()

    fireEvent.click(button('Try Automatic Install Again'))
    await flushActions()
    expect(isAriaDisabled(button('Copy Install Command'))).toBe(true)

    // A failed retry never rejects — main pushes a new recovery status a moment later.
    pushFreshRecovery(view)

    expect(isAriaDisabled(button('Copy Install Command'))).toBe(false)
    expect(isAriaDisabled(button('Show Package'))).toBe(false)
    expect(isAriaDisabled(button('Try Automatic Install Again'))).toBe(false)

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    expect(getInstructions).toHaveBeenCalledTimes(1)
    expect(writeClipboardText).toHaveBeenCalledWith(INSTALL_COMMAND)
    expect(footnoteText()).toBe(COPIED_NOTE)
  })

  it('leaves an in-flight hash job busy when a fresh recovery status arrives', () => {
    const pending = deferred<typeof INSTRUCTIONS>()
    getInstructions.mockReturnValue(pending.promise)
    const view = renderCard()

    fireEvent.click(button('Copy Install Command'))
    pushFreshRecovery(view)

    // Why: the release is scoped to the retry slot — a running hash must keep its busy state.
    expect(button('Checking package...')).toBeTruthy()
    expect(isAriaDisabled(button('Show Package'))).toBe(true)

    pending.resolve(INSTRUCTIONS)
  })

  it('also releases the busy slot if the preload call itself rejects', async () => {
    quitAndInstall.mockRejectedValue(new Error('Error: updater is not initialized'))
    renderCard()

    fireEvent.click(button('Try Automatic Install Again'))
    await flushActions()

    expect(footnoteText()).toBe('updater is not initialized')
    expect(isAriaDisabled(button('Copy Install Command'))).toBe(false)
    expect(isAriaDisabled(button('Show Package'))).toBe(false)
  })
})

describe('LinuxPackageInstallRecoveryCard reveal', () => {
  it('reveals the retained package from the link-style action', async () => {
    renderCard()

    const show = button('Show Package')
    expect(show.dataset.variant).toBe('link')
    // The link-style action still has to meet the touch-target floor.
    expect(show.className).toContain('min-h-[44px]')

    fireEvent.click(show)
    await flushActions()

    expect(showLinuxPackage).toHaveBeenCalledTimes(1)
    expect(footnoteElement()).toBeNull()
  })

  it('reports a failed reveal in place', async () => {
    showLinuxPackage.mockRejectedValue(new Error('Package file is missing.'))
    renderCard()

    fireEvent.click(button('Show Package'))
    await flushActions()

    expect(footnoteText()).toBe('Package file is missing.')
    // Why: a reveal failure is not a command-build failure, so the copy path must survive it.
    expect(button('Copy Install Command')).toBeTruthy()
  })
})

describe('LinuxPackageInstallRecoveryCard without a usable command', () => {
  it('promotes Show Package and keeps the official-release fallback', async () => {
    getInstructions.mockResolvedValue(NO_PACKAGE_MANAGER)
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    expect(screen.queryByRole('button', { name: 'Copy Install Command' })).toBeNull()
    expect(button('Show Package').dataset.variant).toBe('default')
    expect(button('Try Automatic Install Again')).toBeTruthy()
    expect(footnoteText()).toBe(NO_PACKAGE_MANAGER.message)
    // The copy-and-run explainer would be dead advice with no command to copy.
    expect(screen.queryByText(/Copy the command and run it/)).toBeNull()

    fireEvent.click(button('Download Manually'))
    expect(openUrl).toHaveBeenCalledWith(RELEASE_URL)
  })

  it('demotes on a no-sudo verdict without needing a rejection', async () => {
    getInstructions.mockResolvedValue({
      ok: false,
      reason: 'no-sudo',
      message: 'No sudo binary is available on this machine.'
    })
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    expect(footnoteText()).toBe('No sudo binary is available on this machine.')
    expect(button('Show Package').dataset.variant).toBe('default')
    expect(button('Download Manually')).toBeTruthy()
  })

  it('still reveals the package after the command build failed', async () => {
    getInstructions.mockResolvedValue(NO_PACKAGE_MANAGER)
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    fireEvent.click(button('Show Package'))
    await flushActions()

    expect(showLinuxPackage).toHaveBeenCalledTimes(1)
  })

  it('restores the copy path when the automatic install is retried', async () => {
    getInstructions.mockResolvedValueOnce(NO_PACKAGE_MANAGER)
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()
    expect(screen.queryByRole('button', { name: 'Copy Install Command' })).toBeNull()

    // Why: a retry re-evaluates the machine, so the earlier "no command" verdict must not stick.
    fireEvent.click(button('Try Automatic Install Again'))
    await flushActions()

    expect(quitAndInstall).toHaveBeenCalledTimes(1)
    expect(button('Copy Install Command').dataset.variant).toBe('default')
    expect(button('Show Package').dataset.variant).toBe('link')
    expect(screen.getByText(/Copy the command and run it/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Download Manually' })).toBeNull()
  })

  it('copies again once a fresh recovery status follows a failed retry', async () => {
    getInstructions.mockResolvedValueOnce(NO_PACKAGE_MANAGER)
    const view = renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    fireEvent.click(button('Try Automatic Install Again'))
    await flushActions()
    pushFreshRecovery(view)

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    expect(writeClipboardText).toHaveBeenCalledWith(INSTALL_COMMAND)
    expect(footnoteText()).toBe(COPIED_NOTE)
  })
})

describe('LinuxPackageInstallRecoveryCard keyboard', () => {
  it('activates the primary action with Enter from the keyboard', async () => {
    const user = userEvent.setup()
    renderCard()

    const copyButton = button('Copy Install Command')
    copyButton.focus()
    expect(document.activeElement).toBe(copyButton)

    await user.keyboard('{Enter}')
    await flushActions()

    expect(getInstructions).toHaveBeenCalledTimes(1)
    expect(writeClipboardText).toHaveBeenCalledWith(INSTALL_COMMAND)
  })

  it('reaches every recovery action in tab order', async () => {
    const user = userEvent.setup()
    renderCard()

    const order = [
      'Minimize to status bar',
      'Show details',
      'Copy Install Command',
      'Try Automatic Install Again',
      'Show Package'
    ]
    for (const name of order) {
      await user.tab()
      expect(document.activeElement).toBe(button(name))
    }
  })

  it('keeps busy actions reachable by keyboard', () => {
    const pending = deferred<typeof INSTRUCTIONS>()
    getInstructions.mockReturnValue(pending.promise)
    renderCard()

    fireEvent.click(button('Copy Install Command'))

    // Why: aria-disabled keeps the control in the tab sequence; native disabled would remove it.
    const show = button('Show Package')
    show.focus()
    expect(document.activeElement).toBe(show)
    expect(show.hasAttribute('disabled')).toBe(false)

    pending.resolve(INSTRUCTIONS)
  })
})
