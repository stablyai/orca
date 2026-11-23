import { FlatList, Image, Pressable, Text, View } from 'react-native'
import { Camera, Check, ImagePlus, type LucideIcon } from 'lucide-react-native'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, feedback, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import type {
  RecentPhotoAccess,
  RecentPhotoLibrary
} from '../../../../platform/media-picking/media-picker-contract'

const TILE_SIZE = 76

type StripItem = { kind: 'camera' } | { kind: 'photo'; id: string } | { kind: 'manage' }

/** Camera first, then the newest photos; a tap toggles a photo in or out of the selection. */
export function MobileRecentPhotoStrip({
  library,
  access,
  ids,
  selected,
  selectionFull,
  onCamera,
  onTogglePhoto,
  onManage
}: {
  library: RecentPhotoLibrary | null
  access: RecentPhotoAccess | null
  ids: readonly string[]
  selected: ReadonlySet<string>
  selectionFull: boolean
  onCamera: (() => void) | undefined
  onTogglePhoto: (id: string) => void
  onManage: () => void
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const items = stripItems(onCamera !== undefined, library !== null ? access : 'denied', ids)
  if (items.length === 0) {
    return null
  }
  return (
    <FlatList
      horizontal
      data={items}
      keyExtractor={(item) => (item.kind === 'photo' ? item.id : item.kind)}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.strip}
      initialNumToRender={6}
      windowSize={3}
      renderItem={({ item }) => {
        if (item.kind === 'camera') {
          return (
            <ActionTile
              icon={Camera}
              label={t('session.nativeChatAddContext.camera', 'Camera')}
              onPress={onCamera}
            />
          )
        }
        if (item.kind === 'manage') {
          return (
            <ActionTile
              icon={ImagePlus}
              label={t('session.nativeChatAddContext.choosePhotos', 'Choose photos')}
              onPress={onManage}
            />
          )
        }
        return library ? (
          <PhotoTile
            library={library}
            id={item.id}
            selected={selected.has(item.id)}
            disabled={selectionFull && !selected.has(item.id)}
            onPress={() => onTogglePhoto(item.id)}
          />
        ) : null
      }}
    />
  )
}

function stripItems(
  camera: boolean,
  access: RecentPhotoAccess | null,
  ids: readonly string[]
): StripItem[] {
  const photos: StripItem[] = access === 'denied' ? [] : ids.map((id) => ({ kind: 'photo', id }))
  const leading: StripItem[] = camera ? [{ kind: 'camera' }] : []
  const trailing: StripItem[] = access === 'limited' ? [{ kind: 'manage' }] : []
  return [...leading, ...photos, ...trailing]
}

function ActionTile({
  icon: Icon,
  label,
  onPress
}: {
  icon: LucideIcon
  label: string
  onPress: (() => void) | undefined
}) {
  useMobileColorScheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, styles.actionTile, pressed && styles.pressed]}
    >
      <Icon size={22} color={colors.textPrimary} strokeWidth={2} />
      <Text style={styles.actionLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

function PhotoTile({
  library,
  id,
  selected,
  disabled,
  onPress
}: {
  library: RecentPhotoLibrary
  id: string
  selected: boolean
  disabled: boolean
  onPress: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={t('session.nativeChatAddContext.recentPhoto', 'Recent photo')}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Image source={{ uri: library.thumbnailUri(id) }} style={styles.photo} resizeMode="cover" />
      {selected ? (
        <View style={styles.selectedRing} pointerEvents="none">
          <View style={styles.check}>
            <Check size={12} color={colors.onAccent} strokeWidth={3} />
          </View>
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  strip: {
    paddingBottom: spacing.md,
    gap: spacing.sm
  },
  tile: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    borderRadius: radii.tile,
    backgroundColor: colors.sheetGroup,
    overflow: 'hidden'
  },
  actionTile: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  actionLabel: {
    color: colors.textPrimary,
    fontSize: typography.metaSize
  },
  photo: {
    width: TILE_SIZE,
    height: TILE_SIZE
  },
  selectedRing: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: radii.tile,
    borderWidth: 2,
    borderColor: colors.accentBlue,
    alignItems: 'flex-end',
    padding: spacing.xs
  },
  check: {
    width: 18,
    height: 18,
    borderRadius: radii.pill,
    backgroundColor: colors.accentBlue,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: {
    opacity: feedback.pressedOpacity
  },
  disabled: {
    opacity: feedback.disabledOpacity
  }
}))
