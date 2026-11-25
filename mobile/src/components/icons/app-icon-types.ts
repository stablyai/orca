import type { LucideIcon } from 'lucide-react-native'

/** The platform symbols that stand in for a Lucide icon on a phone. */
export type NativeIconSymbol = { ios: string; android: string; iosFill?: string }

/** An icon component; on a phone it also names its native symbols, so native menus can show it. */
export type AppIcon = LucideIcon & { nativeSymbol?: NativeIconSymbol }
