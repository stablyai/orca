import { createCodexSessionResumeLaunchPreparation } from '../codex/history/resume/codex-session-resume-launch-preparation'
import { mainProcessState as state } from './main-process-state'

const desktopResumeLaunch = createCodexSessionResumeLaunchPreparation({
  getRuntimeHome: () => state.codexRuntimeHome,
  getSettings: () => state.store?.getSettings()
})

export const { prepareCodexSessionResumeForLaunch, prepareCodexPinnedLaunchHome } =
  desktopResumeLaunch
