import type { Store } from '../persistence'

type OnboardingCompletedDeps = {
  store: Store
  isCooldownActive: (deferredUntil: number | null | undefined) => boolean
  isEvaluating: () => boolean
  queueAfterEvaluation: () => void
  isPromptVisible: () => boolean
  clearVisiblePrompt: () => void
  showToast: () => Promise<boolean>
}

export async function handleStarNagOnboardingCompleted(
  deps: OnboardingCompletedDeps
): Promise<void> {
  const ui = deps.store.getUI()
  const cooldownActive = deps.isCooldownActive(ui.starNagDeferredUntil)
  if (ui.starNagCompleted || cooldownActive || deps.isEvaluating()) {
    if (!ui.starNagCompleted && !cooldownActive && deps.isEvaluating()) {
      deps.queueAfterEvaluation()
    }
    return
  }
  if (deps.isPromptVisible()) {
    deps.clearVisiblePrompt()
  }
  await deps.showToast()
}
