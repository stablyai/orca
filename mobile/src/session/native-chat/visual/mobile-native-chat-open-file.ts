import { splitFilePathLineSuffix } from '../../../components/markdown-file-path-detection'
import {
  openMobileFileTap,
  type FileTapSessionTab,
  type OpenMobileFileTapOptions
} from '../../mobile-file-tap-open'

export type OpenMobileNativeChatFileTapOptions<T extends FileTapSessionTab> = Omit<
  OpenMobileFileTapOptions<T>,
  'terminalHandle' | 'cwd' | 'candidates'
> & { pathText: string }

// Resolve chat citations from worktree root without terminal cwd/handle; a live terminal subdirectory would misplace them. Preserve path:line:column locations.
export function openMobileNativeChatFileTap<T extends FileTapSessionTab>(
  options: OpenMobileNativeChatFileTapOptions<T>
): void {
  const { pathText, ...rest } = options
  const { path, line, column } = splitFilePathLineSuffix(pathText)
  openMobileFileTap<T>({ ...rest, candidates: [{ pathText: path, line, column }] })
}
