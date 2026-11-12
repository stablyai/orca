export type ApplicationsFolderMoveDecision = 'move' | 'not-now' | 'never'

export type ApplicationsFolderMoveConflict = 'exists' | 'existsAndRunning'

export type ApplicationsFolderMoveEligibility = {
  platform: NodeJS.Platform
  isPackaged: boolean
  isServeMode: boolean
  isAutomatedLaunch: boolean
  offerEnabled: boolean
  onboardingOpen: boolean
  isInApplicationsFolder: () => boolean
}

export function shouldOfferApplicationsFolderMove(
  eligibility: ApplicationsFolderMoveEligibility
): boolean {
  if (eligibility.platform !== 'darwin' || !eligibility.isPackaged) {
    return false
  }
  if (eligibility.isServeMode || eligibility.isAutomatedLaunch) {
    return false
  }
  if (!eligibility.offerEnabled || eligibility.onboardingOpen) {
    return false
  }
  // Darwin-only Electron API, so it is read only after the platform gate.
  return !eligibility.isInApplicationsFolder()
}

export function resolveApplicationsFolderMoveConflict(
  conflict: ApplicationsFolderMoveConflict,
  handlers: { confirmReplace: () => boolean; explainRunningCopy: () => void }
): boolean {
  // Electron's default focuses the running copy and quits this one; refuse so neither session is dropped.
  if (conflict === 'existsAndRunning') {
    handlers.explainRunningCopy()
    return false
  }
  return handlers.confirmReplace()
}

export type ApplicationsFolderMoveHandlers = {
  prompt: () => Promise<ApplicationsFolderMoveDecision>
  isQuitting: () => boolean
  optOut: () => void
  move: () => boolean
  onPromptFailed: (error: unknown) => void
  onMoveFailed: (error: unknown) => void
}

// Electron throws this (rather than returning false) when the user cancels the admin prompt.
const AUTHORIZATION_REJECTED_MESSAGE = 'User rejected the authorization request'

export async function handleApplicationsFolderMoveOffer(
  handlers: ApplicationsFolderMoveHandlers
): Promise<void> {
  let decision: ApplicationsFolderMoveDecision
  try {
    decision = await handlers.prompt()
  } catch (error) {
    handlers.onPromptFailed(error)
    return
  }
  if (handlers.isQuitting()) {
    return
  }
  if (decision === 'never') {
    handlers.optOut()
    return
  }
  if (decision !== 'move') {
    return
  }
  try {
    // On success Electron quits through the normal quit path and reopens the moved copy.
    handlers.move()
  } catch (error) {
    if (error instanceof Error && error.message === AUTHORIZATION_REJECTED_MESSAGE) {
      return
    }
    handlers.onMoveFailed(error)
  }
}
