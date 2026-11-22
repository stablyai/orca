import type { ComponentType } from 'react'
import type { LucideIcon, LucideProps } from 'lucide-react-native'
import type { AppIcon, NativeIconSymbol } from './app-icon-types'

/** Lets an icon drawn without Lucide stand in where callers take a Lucide icon. */
export function asAppIcon(
  component: ComponentType<LucideProps>,
  nativeSymbol?: NativeIconSymbol
): AppIcon {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers only render it with LucideProps; Lucide's forwardRef brand is never read.
  const icon = component as LucideIcon
  return nativeSymbol ? Object.assign(icon, { nativeSymbol }) : icon
}
