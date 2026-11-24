// Name and picture: the desktop header's rename and picture picker on one page. Everything, a picked
// photo included, saves on Done, so Cancel keeps the picture: an upload overwrites the bot's only copy.
// No Generate: it runs an image agent on the computer you look from, and a phone has none.
import { useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { ImageUp } from 'lucide-react-native'
import {
  mascotAvatar,
  parseBotAvatar,
  PICKABLE_BOT_MASCOT_IDS,
  type BotMascotId
} from '../../../src/shared/bot-avatar'
import {
  BOT_AVATAR_COLORS,
  DEFAULT_BOT_AVATAR_COLOR
} from '../../../src/shared/bots/bot-avatar-color'
import { BOT_NAME_MAX_LENGTH } from '../../../src/shared/bot-types'
import {
  BOT_AVATAR_OUTFITS,
  wornBotOutfit,
  type BotAvatarOutfit
} from '../../../src/shared/bots/bot-avatar-outfit'
import type { BotUpdateParams } from '../../../src/shared/rpc-contract/bots-params'
import { TextField } from '../components/composer-input/TextField'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import {
  MobileSegmentedControl,
  type MobileSegment
} from '../components/controls/MobileSegmentedControl'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ImageLibraryPermissionError } from '../platform/media-picking/media-picker-contract'
import { useMediaPicker } from '../platform/media-picking/media-picker'
import { SettingsNote } from '../settings/settings-screen-frame'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { BotAvatarPhotoError, botAvatarPngFromPhoto } from './bot-avatar-photo'
import type { SheetBot } from './bot-sheet-operations'
import type { MobileBotAvatarSource } from './host-bot-row-facts'
import { MobileBotAvatar } from './MobileBotAvatar'

type IdentityUpdates = Pick<
  BotUpdateParams['updates'],
  'name' | 'avatar' | 'avatarColor' | 'avatarOutfit'
>

// Seven to a row: the 19 mascots end on a row of five, not one.
const COLUMNS = 7

export function MobileBotIdentityPage(props: {
  bot: SheetBot
  avatar: MobileBotAvatarSource
  /** The host keeps a mascot's background; an older one drops it, so the row hides. */
  takesColor: boolean
  /** The host keeps what a mascot wears; an older one refuses it, so the outfits hide. */
  takesOutfit: boolean
  disabled: boolean
  banner: ReactNode
  onCancel: () => void
  /** Saves the changed fields; resolves true once the host took them. */
  onSave: (updates: IdentityUpdates) => Promise<boolean>
  /** Uploads a square 512 px PNG; resolves true once the host took it. */
  onUpload: (png: string) => Promise<boolean>
  showToast: (message: string) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const picker = useMediaPicker()
  const { bot } = props
  // As the page opened: only what is changed here is sent, so an edit made elsewhere meanwhile stays.
  const [opened] = useState(() => {
    const saved = parseBotAvatar(bot.avatar)
    return {
      name: bot.name,
      mascot: saved?.kind === 'mascot' ? saved.id : null,
      color: bot.avatarColor ?? null,
      outfit: bot.avatarOutfit ?? null
    }
  })
  const [name, setName] = useState(opened.name)
  const [mascot, setMascot] = useState<BotMascotId | null>(opened.mascot)
  const [color, setColor] = useState<string | null>(opened.color)
  // Unpicked, an outfit this version doesn't know draws as none and stays saved; picked, it is replaced.
  const [picked, setOutfit] = useState<BotAvatarOutfit | null | undefined>(undefined)
  const outfit = picked === undefined ? wornBotOutfit(opened.outfit) : picked
  const [photo, setPhoto] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [width, setWidth] = useState(0)

  const [tab, setTab] = useState<'mascot' | 'color' | 'outfit'>('mascot')
  const look = (
    id: BotMascotId,
    worn: BotAvatarOutfit | null,
    tint: string | null = color
  ): MobileBotAvatarSource => ({
    kind: 'mascot',
    id,
    ...(tint ? { color: tint } : {}),
    ...(worn ? { outfit: worn } : {})
  })
  const preview: MobileBotAvatarSource = mascot
    ? look(mascot, outfit)
    : photo
      ? { kind: 'image', uri: `data:image/png;base64,${photo}` }
      : props.avatar
  const trimmed = name.trim()
  const done = async () => {
    if (trimmed === '') {
      return
    }
    const updates: IdentityUpdates = {
      ...(trimmed !== opened.name ? { name: trimmed } : {}),
      ...(mascot && mascot !== opened.mascot ? { avatar: mascotAvatar(mascot) } : {}),
      ...(mascot && props.takesColor && color !== opened.color ? { avatarColor: color } : {}),
      ...(mascot && props.takesOutfit && picked !== undefined && picked !== opened.outfit
        ? { avatarOutfit: picked }
        : {})
    }
    // A mascot picked after the photo replaces it.
    const png = mascot ? null : photo
    const edits = Object.keys(updates).length > 0
    if (!edits && !png) {
      props.onCancel()
      return
    }
    setBusy(true)
    const ok = (!edits || (await props.onSave(updates))) && (!png || (await props.onUpload(png)))
    setBusy(false)
    if (ok) {
      props.onCancel()
    }
  }
  const choosePhoto = async () => {
    setBusy(true)
    try {
      const picked = await picker.pickImage('library')
      if (!picked) {
        return
      }
      setPhoto(await botAvatarPngFromPhoto(picked))
      setMascot(null)
    } catch (error) {
      props.showToast(
        error instanceof BotAvatarPhotoError
          ? error.message
          : error instanceof ImageLibraryPermissionError
            ? t('bots.picture.permissionDenied', 'Photo permission denied')
            : t('bots.picture.unreadable', "Orca can't read that image. Try PNG or JPEG.")
      )
    } finally {
      setBusy(false)
    }
  }

  const gap = spacing.sm
  const tile = width > 0 ? Math.floor((width - gap * (COLUMNS - 1)) / COLUMNS) : 0
  const current = color ?? DEFAULT_BOT_AVATAR_COLOR
  const swatches: readonly string[] = BOT_AVATAR_COLORS.some((swatch) => swatch === current)
    ? BOT_AVATAR_COLORS
    : [...BOT_AVATAR_COLORS, current]
  const locked = props.disabled || busy
  const colorNames: Record<string, string> = {
    '#b3dbf4': t('bots.picture.colorSky', 'Sky'),
    '#ffffff': t('bots.picture.colorWhite', 'White'),
    '#c9b8e8': t('bots.picture.colorLavender', 'Lavender'),
    '#f4c4cf': t('bots.picture.colorPink', 'Pink'),
    '#f8cfa8': t('bots.picture.colorPeach', 'Peach'),
    '#f6e3a1': t('bots.picture.colorButter', 'Butter'),
    '#c5dfb5': t('bots.picture.colorSage', 'Sage'),
    '#b5e3d8': t('bots.picture.colorMint', 'Mint'),
    '#8fa3b8': t('bots.picture.colorSlate', 'Slate'),
    '#3a3f4b': t('bots.picture.colorGraphite', 'Graphite'),
    '#1f2126': t('bots.picture.colorInk', 'Ink')
  }
  const outfitNames: Record<BotAvatarOutfit, string> = {
    tie: t('bots.picture.outfitTie', 'Tie'),
    detective: t('bots.picture.outfitDetective', 'Detective'),
    'hard-hat': t('bots.picture.outfitHardHat', 'Hard hat'),
    reviewer: t('bots.picture.outfitReviewer', 'Reviewer'),
    'night-shift': t('bots.picture.outfitNightShift', 'Night shift'),
    artist: t('bots.picture.outfitArtist', 'Artist'),
    scientist: t('bots.picture.outfitScientist', 'Scientist'),
    party: t('bots.picture.outfitParty', 'Party'),
    security: t('bots.picture.outfitSecurity', 'Security')
  }
  // Color and Outfit dress the picked mascot, so a photo shows the mascots alone.
  const tabs: MobileSegment<'mascot' | 'color' | 'outfit'>[] = mascot
    ? [
        { value: 'mascot', label: t('bots.picture.mascot', 'Mascot') },
        ...(props.takesColor
          ? [{ value: 'color' as const, label: t('bots.picture.color', 'Color') }]
          : []),
        ...(props.takesOutfit
          ? [{ value: 'outfit' as const, label: t('bots.picture.outfit', 'Outfit') }]
          : [])
      ]
    : []
  const shown = tabs.some((entry) => entry.value === tab) ? tab : 'mascot'
  return (
    <>
      <SheetHeader
        title={t('bots.picture.title', 'Name and picture')}
        leading={{ label: t('common.cancel', 'Cancel'), onPress: props.onCancel }}
        trailing={{
          label: t('common.done', 'Done'),
          onPress: () => void done(),
          disabled: locked || trimmed === '',
          busy
        }}
      />
      {props.banner}
      <View style={styles.hero}>
        <MobileBotAvatar avatar={preview} size={88} />
      </View>
      <TextField
        value={name}
        onChangeText={setName}
        maxLength={BOT_NAME_MAX_LENGTH}
        editable={!locked}
        accessibilityLabel={t('bots.picture.nameLabel', 'Bot name')}
        returnKeyType="done"
        onSubmitEditing={() => void done()}
      />
      {tabs.length > 1 ? (
        <MobileSegmentedControl
          segments={tabs}
          selected={shown}
          onSelect={setTab}
          fill
          onSheet
          tabs
          style={styles.tabs}
        />
      ) : (
        <SectionHeader title={t('bots.picture.mascot', 'Mascot')} />
      )}
      <View
        style={[styles.grid, { gap, minHeight: tabs.length > 1 ? 3 * tile + 2 * gap : 0 }]}
        accessibilityRole="radiogroup"
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {tile === 0
          ? null
          : shown === 'color' && mascot
            ? swatches.map((swatch) => (
                <Tile
                  key={swatch}
                  label={colorNames[swatch] ?? swatch}
                  checked={swatch === current}
                  disabled={locked}
                  onPress={() => setColor(swatch === DEFAULT_BOT_AVATAR_COLOR ? null : swatch)}
                  avatar={look(mascot, outfit, swatch)}
                  size={tile}
                />
              ))
            : shown === 'outfit' && mascot
              ? [null, ...BOT_AVATAR_OUTFITS].map((worn) => (
                  <Tile
                    key={worn ?? 'none'}
                    label={worn ? outfitNames[worn] : t('bots.picture.outfitNone', 'No outfit')}
                    checked={worn === outfit}
                    disabled={locked}
                    onPress={() => setOutfit(worn)}
                    avatar={look(mascot, worn)}
                    size={tile}
                  />
                ))
              : PICKABLE_BOT_MASCOT_IDS.map((id, index) => (
                  <Tile
                    key={id}
                    label={t('bots.picture.mascotN', 'Mascot {{n}} of {{total}}', {
                      n: index + 1,
                      total: PICKABLE_BOT_MASCOT_IDS.length
                    })}
                    checked={id === mascot}
                    disabled={locked}
                    onPress={() => setMascot(id)}
                    avatar={look(id, null)}
                    size={tile}
                  />
                ))}
      </View>
      <ListGroup style={styles.photos}>
        <ListRow
          leading={<ImageUp size={18} color={colors.textSecondary} />}
          title={t('bots.picture.choosePhoto', 'Choose from Photos')}
          navigates
          busy={busy}
          disabled={locked}
          onPress={() => void choosePhoto()}
        />
      </ListGroup>
      {bot.slack ? (
        <SettingsNote>
          {t('bots.picture.slackToo', 'Changes your bot’s picture in Slack too.')}
        </SettingsNote>
      ) : null}
    </>
  )
}

function Tile(props: {
  label: string
  checked: boolean
  disabled: boolean
  onPress: () => void
  avatar: MobileBotAvatarSource
  size: number
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.checked, disabled: props.disabled }}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.tile, props.checked && styles.tileOn]}
    >
      <MobileBotAvatar avatar={props.avatar} size={props.size - 6} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  hero: { alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.lg },
  tabs: { marginTop: spacing.lg, marginBottom: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', alignContent: 'flex-start' },
  tile: {
    padding: 1,
    borderRadius: radii.control,
    borderWidth: 2,
    borderColor: 'transparent'
  },
  tileOn: { borderColor: colors.textPrimary },
  photos: { marginTop: spacing.lg }
}))
