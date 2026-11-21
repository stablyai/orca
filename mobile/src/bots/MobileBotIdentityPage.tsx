// Name and picture: the desktop header's rename and picture picker on one page. A photo uploads as it
// is picked, as the desktop's does; the name, mascot and background save on Done. No Generate: it runs an
// image agent on the computer you look from, and a phone has none.
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
import type { BotUpdateParams } from '../../../src/shared/rpc-contract/bots-params'
import { TextField } from '../components/composer-input/TextField'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
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

type IdentityUpdates = Pick<BotUpdateParams['updates'], 'name' | 'avatar' | 'avatarColor'>

// Seven to a row: the 19 mascots end on a row of five, not one.
const COLUMNS = 7

export function MobileBotIdentityPage(props: {
  bot: SheetBot
  avatar: MobileBotAvatarSource
  /** The host keeps a mascot's background; an older one drops it, so the row hides. */
  takesColor: boolean
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
  const [opened, setOpened] = useState(() => {
    const saved = parseBotAvatar(bot.avatar)
    return {
      name: bot.name,
      mascot: saved?.kind === 'mascot' ? saved.id : null,
      color: bot.avatarColor ?? null
    }
  })
  const [name, setName] = useState(opened.name)
  const [mascot, setMascot] = useState<BotMascotId | null>(opened.mascot)
  const [color, setColor] = useState<string | null>(opened.color)
  const [photo, setPhoto] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [width, setWidth] = useState(0)

  const preview: MobileBotAvatarSource = mascot
    ? { kind: 'mascot', id: mascot, ...(color ? { color } : {}) }
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
      ...(mascot && props.takesColor && color !== opened.color ? { avatarColor: color } : {})
    }
    if (Object.keys(updates).length === 0) {
      props.onCancel()
      return
    }
    setBusy(true)
    const ok = await props.onSave(updates)
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
      const png = await botAvatarPngFromPhoto(picked)
      if (await props.onUpload(png)) {
        setPhoto(png)
        // The photo is saved now, so picking the earlier mascot again is a change.
        setOpened((held) => ({ ...held, mascot: null }))
        setMascot(null)
      }
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
      <SectionHeader title={t('bots.picture.mascot', 'Mascot')} />
      <View
        style={[styles.grid, { gap }]}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {tile > 0
          ? PICKABLE_BOT_MASCOT_IDS.map((id, index) => (
              <Pressable
                key={id}
                accessibilityRole="radio"
                accessibilityState={{ checked: id === mascot, disabled: locked }}
                accessibilityLabel={t('bots.picture.mascotN', 'Mascot {{n}} of {{total}}', {
                  n: index + 1,
                  total: PICKABLE_BOT_MASCOT_IDS.length
                })}
                disabled={locked}
                onPress={() => setMascot(id)}
                style={[styles.tile, id === mascot && styles.tileOn]}
              >
                <MobileBotAvatar
                  avatar={{ kind: 'mascot', id, ...(color ? { color } : {}) }}
                  size={tile - 6}
                />
              </Pressable>
            ))
          : null}
      </View>
      {mascot && props.takesColor ? (
        <>
          <SectionHeader title={t('bots.picture.background', 'Background color')} />
          <View style={styles.swatches} accessibilityRole="radiogroup">
            {swatches.map((swatch) => (
              <Pressable
                key={swatch}
                accessibilityRole="radio"
                accessibilityState={{ checked: swatch === current, disabled: locked }}
                accessibilityLabel={colorNames[swatch] ?? swatch}
                hitSlop={4}
                disabled={locked}
                onPress={() => setColor(swatch === DEFAULT_BOT_AVATAR_COLOR ? null : swatch)}
                style={[styles.ring, swatch === current && styles.ringOn]}
              >
                <View style={[styles.swatch, { backgroundColor: swatch }]} />
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
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

const styles = themedStyleSheet(() => ({
  hero: { alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: {
    padding: 1,
    borderRadius: radii.control,
    borderWidth: 2,
    borderColor: 'transparent'
  },
  tileOn: { borderColor: colors.textPrimary },
  swatches: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: spacing.sm
  },
  ring: {
    padding: 2,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: 'transparent'
  },
  ringOn: { borderColor: colors.textPrimary },
  swatch: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  photos: { marginTop: spacing.lg }
}))
