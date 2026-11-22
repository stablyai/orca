import type { NativeIconSymbol } from '../../components/icons/app-icon-types'
import {
  NATIVE_ICON_SYMBOLS,
  type NativeIconName
} from '../../components/icons/native-icon-symbols'

// The page names Lucide's canonical component; these app names are aliases Lucide renamed since.
const LUCIDE_RENAMES: Readonly<Record<string, NativeIconName>> = {
  CircleQuestionMark: 'CircleHelp',
  CircleUser: 'UserCircle',
  CodeXml: 'Code2',
  FileCodeCorner: 'FileCode2',
  FileMinusCorner: 'FileMinus2',
  FilePlusCorner: 'FilePlus2',
  PenLine: 'Edit3',
  ShieldQuestionMark: 'ShieldQuestion',
  SquareDashedText: 'TextSelect'
}

function isNativeIconName(name: string): name is NativeIconName {
  return Object.hasOwn(NATIVE_ICON_SYMBOLS, name)
}

/** The symbols for an icon a page named; undefined for one this shell doesn't know, which then shows its label. */
export function pageHeaderSymbol(name: string | undefined): NativeIconSymbol | undefined {
  if (name === undefined) {
    return undefined
  }
  // Own keys only: a page-sent name like `constructor` must not reach the prototype.
  const known = isNativeIconName(name)
    ? name
    : Object.hasOwn(LUCIDE_RENAMES, name)
      ? LUCIDE_RENAMES[name]
      : undefined
  if (known === undefined) {
    return undefined
  }
  const [ios, android] = NATIVE_ICON_SYMBOLS[known]
  return { ios, android }
}
