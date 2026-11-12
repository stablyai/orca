import { describe, expect, it, vi } from 'vitest'
import {
  createApplicationsFolderMoveRequest,
  handleApplicationsFolderMoveOffer,
  moveWouldDeleteExistingCopyUnasked,
  resolveApplicationsFolderMoveConflict,
  runApplicationsFolderMove,
  shouldOfferApplicationsFolderMove,
  type ApplicationsFolderMoveDecision,
  type ApplicationsFolderMoveEligibility
} from './applications-folder-move-decision'

function macLaunch(
  overrides: Partial<ApplicationsFolderMoveEligibility> = {}
): ApplicationsFolderMoveEligibility {
  return {
    platform: 'darwin',
    isPackaged: true,
    isServeMode: false,
    isAutomatedLaunch: false,
    offerEnabled: true,
    onboardingOpen: false,
    isInApplicationsFolder: () => false,
    ...overrides
  }
}

function offer(decision: ApplicationsFolderMoveDecision) {
  const handlers = {
    prompt: async () => decision,
    isQuitting: () => false,
    optOut: vi.fn(),
    requestMove: vi.fn(),
    onPromptFailed: vi.fn(),
    onMoveFailed: vi.fn()
  }
  return { handlers, done: handleApplicationsFolderMoveOffer(handlers) }
}

describe('shouldOfferApplicationsFolderMove', () => {
  it('offers a packaged macOS build running outside Applications', () => {
    expect(shouldOfferApplicationsFolderMove(macLaunch())).toBe(true)
  })

  it('stays quiet once Orca is in Applications', () => {
    expect(
      shouldOfferApplicationsFolderMove(macLaunch({ isInApplicationsFolder: () => true }))
    ).toBe(false)
  })

  it('never calls the darwin-only Electron API on other platforms', () => {
    const isInApplicationsFolder = vi.fn(() => false)
    expect(
      shouldOfferApplicationsFolderMove(macLaunch({ platform: 'linux', isInApplicationsFolder }))
    ).toBe(false)
    expect(isInApplicationsFolder).not.toHaveBeenCalled()
  })

  it('respects the opt-out setting', () => {
    expect(shouldOfferApplicationsFolderMove(macLaunch({ offerEnabled: false }))).toBe(false)
  })
})

describe('handleApplicationsFolderMoveOffer', () => {
  it('persists the opt-out for Don’t Ask Again without moving', async () => {
    const { handlers, done } = offer('never')
    await done
    expect(handlers.optOut).toHaveBeenCalledTimes(1)
    expect(handlers.requestMove).not.toHaveBeenCalled()
  })

  it('leaves settings alone for Not Now so the next launch asks again', async () => {
    const { handlers, done } = offer('not-now')
    await done
    expect(handlers.optOut).not.toHaveBeenCalled()
    expect(handlers.requestMove).not.toHaveBeenCalled()
  })
})

describe('runApplicationsFolderMove', () => {
  it('treats a cancelled administrator prompt as the user’s choice, not a failure', () => {
    const onMoveFailed = vi.fn()
    const moved = runApplicationsFolderMove({
      move: () => {
        throw new Error('User rejected the authorization request')
      },
      onMoveFailed
    })
    expect(moved).toBe(false)
    expect(onMoveFailed).not.toHaveBeenCalled()
  })

  it('reports a failed copy so the user learns the session kept running', () => {
    const failure = new Error('Failed to copy current bundle to the applications folder')
    const onMoveFailed = vi.fn()
    const moved = runApplicationsFolderMove({
      move: () => {
        throw failure
      },
      onMoveFailed
    })
    expect(moved).toBe(false)
    expect(onMoveFailed).toHaveBeenCalledWith(failure)
  })
})

describe('resolveApplicationsFolderMoveConflict', () => {
  it('refuses to replace a copy that is already running', () => {
    const confirmReplace = vi.fn(() => true)
    const explainRunningCopy = vi.fn()
    expect(
      resolveApplicationsFolderMoveConflict('existsAndRunning', {
        confirmReplace,
        explainRunningCopy
      })
    ).toBe(false)
    expect(explainRunningCopy).toHaveBeenCalledTimes(1)
    expect(confirmReplace).not.toHaveBeenCalled()
  })

  it('declines when a confirmation dialog throws, because Electron reads a throw as consent', () => {
    expect(
      resolveApplicationsFolderMoveConflict('exists', {
        confirmReplace: () => {
          throw new Error('dialog failed')
        },
        explainRunningCopy: () => {}
      })
    ).toBe(false)
  })
})

describe('moveWouldDeleteExistingCopyUnasked', () => {
  it('blocks replacing an existing copy that needs administrator rights', () => {
    expect(
      moveWouldDeleteExistingCopyUnasked({
        exists: true,
        writable: false,
        applicationsFolderWritable: true
      })
    ).toBe(true)
  })

  it('allows an administrator-authorized install when nothing would be replaced', () => {
    expect(
      moveWouldDeleteExistingCopyUnasked({
        exists: false,
        writable: false,
        applicationsFolderWritable: false
      })
    ).toBe(false)
  })
})

describe('createApplicationsFolderMoveRequest', () => {
  it('lets only the asked window holding the token trigger the move, and only once', () => {
    const request = createApplicationsFolderMoveRequest(7, 'move-token')
    expect(request.settle(8, 'move-token')).toBe(false)
    expect(request.settle(7, 'other-token')).toBe(false)
    expect(request.settle(7, 'move-token')).toBe(true)
    expect(request.settle(7, 'move-token')).toBe(false)
  })

  it('ignores a late answer once the request has expired', () => {
    const request = createApplicationsFolderMoveRequest(7, 'move-token')
    expect(request.expire()).toBe(true)
    expect(request.settle(7, 'move-token')).toBe(false)
  })
})
