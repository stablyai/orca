import { parseExplicitFileLinkTarget } from '../../../src/shared/explicit-file-link-target'
import {
  matchTerminalFileLinkAtColumn,
  type TerminalFileLinkTarget
} from '../../../src/shared/terminal-links'

export type TappedFilePath = TerminalFileLinkTarget

export const matchFilePathAtColumn = matchTerminalFileLinkAtColumn
export const parsePathWithOptionalLineColumn = parseExplicitFileLinkTarget
