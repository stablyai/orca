import type { SkillBundleInstallProgress } from '../../shared/skill-bundle-install-contract'

const POLL_INTERVAL_MS = 150

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, POLL_INTERVAL_MS)
    function finish(): void {
      clearTimeout(timeout)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

export function startSkillInstallProgressPolling(input: {
  read: () => Promise<SkillBundleInstallProgress | null>
  onProgress: (progress: SkillBundleInstallProgress) => void
}): () => void {
  const controller = new AbortController()
  let lastKey = ''
  void (async () => {
    while (!controller.signal.aborted) {
      const progress = await input.read().catch(() => null)
      if (controller.signal.aborted) {
        break
      }
      const key = progress
        ? `${progress.skillId}:${progress.skillIndex}:${progress.skillCount}`
        : ''
      if (progress && key !== lastKey) {
        lastKey = key
        input.onProgress(progress)
      }
      await waitForNextPoll(controller.signal)
    }
  })().catch(() => undefined)
  return () => controller.abort()
}
