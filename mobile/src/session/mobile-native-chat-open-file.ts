import { splitFilePathLineSuffix } from '../components/markdown-file-path-detection'
import {
  openMobileFileTap,
  type FileTapSessionTab,
  type OpenMobileFileTapOptions
} from './mobile-file-tap-open'

export type OpenMobileNativeChatFileTapOptions<T extends FileTapSessionTab> = Omit<
  OpenMobileFileTapOptions<T>,
  'terminalHandle' | 'cwd' | 'line' | 'column'
>

/**
 * Open a file reference tapped in native chat: same haptic / preview-route /
 * tab-activation flow as terminal taps, but chat paths are worktree-root
 * relative (or absolute), so resolution deliberately passes no terminal handle
 * and no cwd — a terminal's live cwd (e.g. `<worktree>/mobile`) would misplace
 * them. Agent-style `path:line(:col)` citations carry their location through.
 */
export function openMobileNativeChatFileTap<T extends FileTapSessionTab>(
  options: OpenMobileNativeChatFileTapOptions<T>
): void {
  const { path, line, column } = splitFilePathLineSuffix(options.pathText)
  openMobileFileTap<T>({
    ...options,
    pathText: path,
    line,
    column
  })
}
