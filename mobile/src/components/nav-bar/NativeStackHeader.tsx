import { useMemo } from 'react'
import { Platform } from 'react-native'
import { Stack, type NativeStackNavigationOptions } from 'expo-router'
import type { SFSymbol } from 'expo-symbols'
import type { NativeIconSymbol } from '../icons/app-icon-types'
import { useMaterialSymbolImages } from '../icons/material-symbol-images'
import { NativeHeaderTitle } from './native-header-title'
import type { ScreenHeaderSubtitle } from './screen-header-props'

type HeaderSymbol = Pick<NativeIconSymbol, 'ios' | 'android'>

/** One row of a header menu, or a row that opens a nested list. */
export type NativeHeaderMenuEntry =
  | {
      key: string
      label: string
      symbol?: HeaderSymbol
      destructive?: boolean
      disabled?: boolean
      isOn?: boolean
      onPress: () => void
    }
  | { key: string; label: string; symbol?: HeaderSymbol; entries: readonly NativeHeaderMenuEntry[] }

/** A bar button, or a bar button that opens a menu whose groups become its sections. */
export type NativeHeaderItem =
  | {
      key: string
      label: string
      symbol?: HeaderSymbol
      disabled?: boolean
      badge?: number
      tint?: string
      onPress: () => void
    }
  | {
      key: string
      label: string
      symbol?: HeaderSymbol
      groups: readonly (readonly NativeHeaderMenuEntry[])[]
    }

const NO_ITEMS: readonly NativeHeaderItem[] = []

function platformSymbol(symbol: HeaderSymbol | undefined): string | undefined {
  return Platform.OS === 'ios' ? symbol?.ios : symbol?.android
}

function entrySymbols(entries: readonly NativeHeaderMenuEntry[]): (HeaderSymbol | undefined)[] {
  return entries.flatMap((entry) =>
    'entries' in entry ? [entry.symbol, ...entrySymbols(entry.entries)] : [entry.symbol]
  )
}

// Toolbar.Button refuses empty slots: a label (when there's no icon) and a badge only when present.
function buttonChildren(label: string | undefined, badge: number | undefined) {
  if (!badge) {
    return label
  }
  const count = <Stack.Toolbar.Badge key="badge">{String(badge)}</Stack.Toolbar.Badge>
  return label === undefined
    ? count
    : [<Stack.Toolbar.Label key="label">{label}</Stack.Toolbar.Label>, count]
}

/**
 * The native stack header: UINavigationBar (Liquid Glass on iOS 26) or the Material top app bar,
 * with UIMenu / dropdown menus. Native screens and the web shell's pages both draw through this.
 */
export function NativeStackHeader({
  title,
  largeTitle = false,
  items = NO_ITEMS,
  leftItems = NO_ITEMS,
  options,
  subtitle,
  onTitlePress,
  titleHint
}: {
  title: string
  largeTitle?: boolean
  items?: readonly NativeHeaderItem[]
  leftItems?: readonly NativeHeaderItem[]
  options?: NativeStackNavigationOptions
  subtitle?: ScreenHeaderSubtitle
  onTitlePress?: () => void
  titleHint?: string
}) {
  // A plain title stays the system's; a status line or a pressable title needs a view of our own.
  const customTitle = title !== '' && (subtitle !== undefined || onTitlePress !== undefined)
  const screenOptions = useMemo(
    () => ({
      ...options,
      headerShown: true,
      title,
      headerLargeTitle: largeTitle,
      ...(customTitle
        ? {
            headerTitle: () => (
              <NativeHeaderTitle
                title={title}
                subtitle={subtitle}
                onPress={onTitlePress}
                accessibilityHint={titleHint}
              />
            )
          }
        : {})
    }),
    [options, title, largeTitle, customTitle, subtitle, onTitlePress, titleHint]
  )
  const all = [...leftItems, ...items]
  const androidImages = useMaterialSymbolImages(
    Platform.OS === 'android'
      ? all
          .flatMap((item) => [
            item.symbol,
            ...('groups' in item ? item.groups.flatMap(entrySymbols) : [])
          ])
          .map(platformSymbol)
          .filter((symbol): symbol is string => symbol !== undefined)
      : []
  )
  const iconOf = (symbol: HeaderSymbol | undefined) => {
    const name = platformSymbol(symbol)
    if (!name) {
      return undefined
    }
    return Platform.OS === 'ios' ? (name as SFSymbol) : (androidImages.get(name) ?? undefined)
  }

  const renderEntry = (entry: NativeHeaderMenuEntry) =>
    'entries' in entry ? (
      <Stack.Toolbar.Menu key={entry.key} title={entry.label} icon={iconOf(entry.symbol)}>
        {entry.entries.map(renderEntry)}
      </Stack.Toolbar.Menu>
    ) : (
      <Stack.Toolbar.MenuAction
        key={entry.key}
        icon={iconOf(entry.symbol)}
        destructive={entry.destructive}
        disabled={entry.disabled}
        isOn={entry.isOn}
        onPress={entry.onPress}
      >
        {entry.label}
      </Stack.Toolbar.MenuAction>
    )

  const renderItem = (item: NativeHeaderItem) => {
    const icon = iconOf(item.symbol)
    return 'groups' in item ? (
      <Stack.Toolbar.Menu key={item.key} icon={icon} accessibilityLabel={item.label}>
        {item.groups.map((group) => (
          // A section is named by its first row, which is what a reordered menu keeps with it.
          <Stack.Toolbar.Menu key={group[0]?.key} inline>
            {group.map(renderEntry)}
          </Stack.Toolbar.Menu>
        ))}
      </Stack.Toolbar.Menu>
    ) : (
      <Stack.Toolbar.Button
        key={item.key}
        icon={icon}
        accessibilityLabel={item.label}
        disabled={item.disabled}
        tintColor={item.tint}
        onPress={item.onPress}
      >
        {buttonChildren(icon === undefined ? item.label : undefined, item.badge)}
      </Stack.Toolbar.Button>
    )
  }

  return (
    <>
      <Stack.Screen options={screenOptions} />
      {leftItems.length > 0 ? (
        <Stack.Toolbar placement="left">{leftItems.map(renderItem)}</Stack.Toolbar>
      ) : null}
      {items.length > 0 ? (
        <Stack.Toolbar placement="right">{items.map(renderItem)}</Stack.Toolbar>
      ) : null}
    </>
  )
}
