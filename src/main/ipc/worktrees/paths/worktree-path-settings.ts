import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'

export type WorktreePathSettings = Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDir'> & {
  /** Mirror Windows-drive repo worktrees into this project runtime's WSL distro; omitted retains default placement. */
  wslMirrorDistro?: string
}
