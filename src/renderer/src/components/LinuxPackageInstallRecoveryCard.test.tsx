// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinuxPackageInstallRecovery } from '../../../shared/update-status-types'

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))

import { LinuxPackageInstallRecoveryCard } from './LinuxPackageInstallRecoveryCard'

const RELEASE_URL = 'https://github.com/stablyai/orca/releases/tag/v1.4.200'
const DIAGNOSTIC = 'pkexec: no polkit authentication agent found'
const INSTALL_COMMAND = 'sudo apt-get install -y /tmp/orca-updates/orca_1.4.200_amd64.deb'
const PACKAGE_FILE_NAME = 'orca_1.4.200_amd64.deb'
const SUMMARY =
  'Orca downloaded the system package. Quit Orca before finishing the update from a terminal.'
const COPIED_NOTE =
  `Command copied. Quit Orca, run it in a system terminal to install ${PACKAGE_FILE_NAME}, ` +
  'then reopen Orca.'
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
const writeClipboardText = vi.fn()
const openUrl = vi.fn()
const onClose = vi.fn()
const allMocks = [
  getInstructions,
  showLinuxPackage,
  writeClipboardText,
  openUrl,
  onClose,
  toastSuccess
]

function makeRecovery(
  overrides: Partial<LinuxPackageInstallRecovery> = {}
): LinuxPackageInstallRecovery {
  return {
    kind: 'linux-package-install',
    packageType: 'deb',
    reason: 'manual-install-required',
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

// Why: each action chains several promises; drain them without depending on timer faking.
async function flushActions(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve()
    }
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
  writeClipboardText.mockResolvedValue(undefined)
  openUrl.mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      shell: { openUrl },
      ui: { writeClipboardText },
      updater: {
        getLinuxPackageInstallInstructions: getInstructions,
        showLinuxPackage
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('LinuxPackageInstallRecoveryCard copy', () => {
  it('leads with the manual-install copy and recovery actions', () => {
    renderCard()

    expect(screen.getByText('Manual Install Required')).toBeTruthy()
    expect(screen.getByText(SUMMARY)).toBeTruthy()
    expect(
      screen.getByText(/a system terminal on the computer where Orca is installed/)
    ).toBeTruthy()
    expect(screen.getByText(/Copy the command, quit Orca/)).toBeTruthy()

    expect(button('Copy Install Command')).toBeTruthy()
    expect(button('Show Package')).toBeTruthy()
    expect(button('Download Manually')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Automatic Install/ })).toBeNull()
  })

  it('never offers the generic Retry Download action', () => {
    renderCard()

    expect(screen.queryByRole('button', { name: 'Retry Download' })).toBeNull()
    expect(button('Download Manually')).toBeTruthy()
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
    expect(toastSuccess).toHaveBeenCalledWith(COPIED_NOTE)
    expect(footnoteElement()).toBeNull()
    expect(button('Copy Install Command')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Command copied' })).toBeNull()
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
    expect(screen.getByText(/Copy the command, quit Orca/)).toBeTruthy()
    expect(button('Download Manually')).toBeTruthy()
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
    expect(screen.getByText('Manual Install Required')).toBeTruthy()
    expect(button('Copy Install Command').dataset.variant).toBe('default')
    expect(button('Show Package').dataset.variant).toBe('outline')
  })

  it('retries the instruction call after a rejection', async () => {
    getInstructions.mockRejectedValueOnce(new Error('Unauthorized updater package recovery sender'))
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    expect(getInstructions).toHaveBeenCalledTimes(2)
    expect(footnoteElement()).toBeNull()
    expect(toastSuccess).toHaveBeenCalledWith(COPIED_NOTE)
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
    expect(button('Show Package').dataset.variant).toBe('outline')
    expect(screen.getByText(/Copy the command, quit Orca/)).toBeTruthy()
    expect(button('Download Manually')).toBeTruthy()
  })

  it('recovers from a clipboard failure on the next copy attempt', async () => {
    writeClipboardText.mockRejectedValueOnce(new Error('Clipboard is unavailable.'))
    renderCard()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    fireEvent.click(button('Copy Install Command'))
    await flushActions()

    expect(writeClipboardText).toHaveBeenCalledTimes(2)
    expect(footnoteElement()).toBeNull()
    expect(toastSuccess).toHaveBeenCalledWith(COPIED_NOTE)
  })

  it('does not write a command after the card unmounts', async () => {
    const pending = deferred<typeof INSTRUCTIONS>()
    getInstructions.mockReturnValue(pending.promise)
    const { unmount } = renderCard()

    fireEvent.click(button('Copy Install Command'))
    unmount()
    pending.resolve(INSTRUCTIONS)
    await flushActions()

    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('does not write a command for a recovery the card has replaced', async () => {
    const pending = deferred<typeof INSTRUCTIONS>()
    getInstructions.mockReturnValue(pending.promise)
    const view = renderCard({ recovery: makeRecovery() })

    fireEvent.click(button('Copy Install Command'))
    view.rerender(cardElement({ recovery: makeRecovery({ version: '1.4.201' }) }))
    pending.resolve(INSTRUCTIONS)
    await flushActions()

    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('ignores an instruction rejection from a same-version recovery cycle', async () => {
    const pending = deferred<typeof INSTRUCTIONS>()
    const recovery = makeRecovery()
    getInstructions.mockReturnValue(pending.promise)
    const view = renderCard({ recovery })

    fireEvent.click(button('Copy Install Command'))
    view.rerender(cardElement({ recovery: { ...recovery } }))
    pending.reject(new Error('Package install recovery is no longer current.'))
    await flushActions()

    expect(footnoteElement()).toBeNull()
    expect(isAriaDisabled(button('Copy Install Command'))).toBe(false)
  })

  it('ignores a clipboard rejection from a replaced recovery cycle', async () => {
    const pending = deferred<void>()
    const recovery = makeRecovery()
    writeClipboardText.mockReturnValue(pending.promise)
    const view = renderCard({ recovery })

    fireEvent.click(button('Copy Install Command'))
    await flushActions()
    expect(writeClipboardText).toHaveBeenCalledWith(INSTALL_COMMAND)

    view.rerender(cardElement({ recovery: { ...recovery } }))
    pending.reject(new Error('Clipboard is unavailable.'))
    await flushActions()

    expect(footnoteElement()).toBeNull()
    expect(toastSuccess).not.toHaveBeenCalled()
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

    fireEvent.click(checking)
    fireEvent.click(button('Show Package'))

    // Why: the buttons stay clickable for focus reasons, so the handlers must do the refusing.
    expect(getInstructions).toHaveBeenCalledTimes(1)
    expect(showLinuxPackage).not.toHaveBeenCalled()

    pending.resolve(INSTRUCTIONS)
    await flushActions()

    expect(toastSuccess).toHaveBeenCalledWith(COPIED_NOTE)
    expect(isAriaDisabled(button('Show Package'))).toBe(false)
  })

  it('dims busy actions instead of relying on the native disabled styling', () => {
    const pending = deferred<typeof INSTRUCTIONS>()
    getInstructions.mockReturnValue(pending.promise)
    renderCard()

    fireEvent.click(button('Copy Install Command'))

    // Why: ui/button styles only `disabled:`, so without these an inert action looks fully live.
    for (const name of ['Checking package...', 'Show Package']) {
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

    expect(screen.getByText('Details')).toBeTruthy()
    expect(screen.queryByText('Last error')).toBeNull()
    // Why: the digest check is a point-in-time claim, not a standing guarantee about the file.
    const detail = screen.getByText(/Orca checks the downloaded file against the release metadata/)
    expect(detail.textContent).not.toContain(DIAGNOSTIC)
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
    const { container } = renderCard({
      diagnostic: long,
      recovery: makeRecovery({ reason: 'authentication-denied' })
    })

    fireEvent.click(button('Show details'))

    const detail = container.querySelector('p.font-mono')
    expect(detail?.className).toContain('max-h-20')
    expect(detail?.className).toContain('overflow-auto')
    expect(detail?.className).toContain('break-words')
    expect(detail?.textContent).toContain('diagnostic-overflow')
  })
})

describe('LinuxPackageInstallRecoveryCard reveal', () => {
  it('reveals the retained package from the secondary action', async () => {
    renderCard()

    const show = button('Show Package')
    expect(show.dataset.variant).toBe('outline')

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

  it('reports a failed official-release open in place', async () => {
    openUrl.mockRejectedValue(new Error('Could not open the release page.'))
    renderCard()

    fireEvent.click(button('Download Manually'))
    await flushActions()

    expect(footnoteText()).toBe('Could not open the release page.')
    expect(footnoteElement()?.className).toContain('text-destructive')
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
    expect(footnoteText()).toBe(NO_PACKAGE_MANAGER.message)
    expect(screen.getByText(/Quit Orca before finishing the update/)).toBeTruthy()

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
      'Show Package',
      'Download Manually'
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
