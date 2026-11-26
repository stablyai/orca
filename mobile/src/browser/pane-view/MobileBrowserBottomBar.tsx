import { useRef, useState, type ComponentType, type Ref, type RefObject } from 'react'
import {
  Keyboard as SoftKeyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type HostInstance,
  type TextInputInstance
} from 'react-native'
import { ChevronLeft, Ellipsis, Keyboard, Lock, RotateCw, X } from 'lucide-react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, feedback, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { TextField } from '../../components/composer-input/TextField'
import { COMPOSER_TEXT_SIZE } from '../../components/composer-input/composer-input-styles'
import { PullDownMenu } from '../../components/nav-bar/PullDownMenu'
import type { ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import { mobileBrowserAddressLabel } from './browser-url'
import { MobileBrowserLoadProgress } from './MobileBrowserLoadProgress'

// BottomSearchBar's 44 pt round buttons and pill, docked under the page instead of floating over a list.
const BAR_CONTROL_SIZE = 44

type IconProps = { size?: number; color?: string; strokeWidth?: number }

type Props = {
  /** The sign-in sheet's page: only the keyboard, no address or page buttons. */
  bare: boolean
  url: string
  canGoBack: boolean
  loading: boolean
  loadFailed: boolean
  bottomInset: number
  keyboardLift: number
  controlsDisabled: boolean
  addressValue: string
  addressFocused: boolean
  setAddressValue: (value: string) => void
  setAddressFocused: (focused: boolean) => void
  navigateToAddress: () => void
  showStop: boolean
  stopPage: () => void
  reloadPage: () => void
  goBack: () => void
  /** Focuses the page's typing field; runs inside the tap so iOS raises the keyboard. */
  onKeyboard: () => void
  menuGroups: readonly (readonly ActionSheetAction[])[]
}

/** Safari's bottom bar in the app's controls: back, the site with the keyboard and reload inside it, and ⋯. */
export function MobileBrowserBottomBar(props: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const menuAnchor = useRef<HostInstance>(null)
  const addressInputRef = useRef<TextInputInstance>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // Cancel stays until the keyboard is down: iOS's late click at the tapped spot would otherwise open ⋯.
  const [editing, setEditing] = useState(false)
  if (props.addressFocused && !editing) {
    setEditing(true)
  } else if (!props.addressFocused && props.keyboardLift === 0 && editing) {
    setEditing(false)
  }
  const keyboard: BarButtonSpec = {
    icon: Keyboard,
    accessibilityLabel: t('browser.bottomBar.typeOnPage', 'Type on page'),
    onPress: props.onKeyboard,
    disabled: props.controlsDisabled
  }
  return (
    <View
      style={[
        styles.bar,
        { paddingBottom: Math.max(props.bottomInset, spacing.sm) },
        // Editing the address rides the keyboard, as the session's other docks do.
        editing && props.keyboardLift > 0
          ? { transform: [{ translateY: -props.keyboardLift - spacing.sm }] }
          : null
      ]}
    >
      {props.bare ? (
        <View style={[styles.row, styles.rowEnd]}>
          <BarButton button={keyboard} />
        </View>
      ) : (
        <View style={styles.row}>
          {!editing && props.canGoBack ? (
            <BarButton
              button={{
                icon: ChevronLeft,
                accessibilityLabel: t('common.back', 'Back'),
                onPress: props.goBack,
                disabled: props.controlsDisabled
              }}
            />
          ) : null}
          <AddressPill {...props} inputRef={addressInputRef} />
          {editing ? (
            <BarButton
              button={{
                icon: X,
                accessibilityLabel: t('common.cancel', 'Cancel'),
                onPress: () => {
                  addressInputRef.current?.blur()
                  SoftKeyboard.dismiss()
                }
              }}
            />
          ) : (
            <BarButton
              ref={menuAnchor}
              button={{
                icon: Ellipsis,
                accessibilityLabel: t('browser.bottomBar.more', 'More'),
                onPress: () => setMenuOpen(true)
              }}
            />
          )}
        </View>
      )}
      <PullDownMenu
        visible={menuOpen}
        anchorRef={menuAnchor}
        groups={props.menuGroups}
        onClose={() => setMenuOpen(false)}
      />
    </View>
  )
}

/** The address field; reading, it shows just the site, centred, with the keyboard and reload at its ends. */
function AddressPill({
  url,
  loading,
  loadFailed,
  controlsDisabled,
  addressValue,
  addressFocused,
  setAddressValue,
  setAddressFocused,
  navigateToAddress,
  showStop,
  stopPage,
  reloadPage,
  onKeyboard,
  inputRef
}: Props & { inputRef: RefObject<TextInputInstance | null> }) {
  const t = useMobileTranslation()
  const label = mobileBrowserAddressLabel(url)
  const ReloadIcon = showStop ? X : RotateCw
  return (
    <View style={styles.pill}>
      <TextField
        inputRef={inputRef}
        style={[styles.pillField, !addressFocused && styles.pillFieldReading]}
        value={addressValue}
        onChangeText={setAddressValue}
        onFocus={() => setAddressFocused(true)}
        onBlur={() => setAddressFocused(false)}
        onSubmitEditing={navigateToAddress}
        selectTextOnFocus
        selection={addressFocused ? undefined : { start: 0, end: 0 }}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
        // Browser reads inputMode, not native keyboardType; keep it undefined on native where it would override URL keyboard.
        inputMode={Platform.OS === 'web' ? 'url' : undefined}
        numberOfLines={1}
        returnKeyType="go"
        placeholder={t('browser.addressField.urlPlaceholder', 'URL')}
        accessibilityLabel={t('browser.bottomBar.address', 'Address')}
        editable={!controlsDisabled}
      />
      {addressFocused ? null : (
        <>
          <View pointerEvents="none" style={styles.pillLabel}>
            {label?.secure ? <Lock size={12} color={colors.textMuted} strokeWidth={2.4} /> : null}
            <Text
              style={[styles.pillText, !label && styles.pillPlaceholder]}
              numberOfLines={1}
              ellipsizeMode={label?.file ? 'middle' : 'tail'}
            >
              {label?.text ?? t('browser.bottomBar.addressPlaceholder', 'Search or enter address')}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [
              styles.pillSlot,
              styles.pillSlotStart,
              pressed && styles.pressed,
              controlsDisabled && styles.disabled
            ]}
            disabled={controlsDisabled}
            onPress={onKeyboard}
            accessibilityRole="button"
            accessibilityLabel={t('browser.bottomBar.typeOnPage', 'Type on page')}
          >
            <Keyboard size={18} color={colors.textSecondary} strokeWidth={2} />
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.pillSlot,
              styles.pillSlotEnd,
              pressed && styles.pressed,
              controlsDisabled && styles.disabled
            ]}
            disabled={controlsDisabled}
            onPress={showStop ? stopPage : reloadPage}
            accessibilityRole="button"
            accessibilityLabel={
              showStop ? t('browser.paneView.stop', 'Stop') : t('browser.paneView.reload', 'Reload')
            }
          >
            <ReloadIcon size={16} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
        </>
      )}
      <MobileBrowserLoadProgress loading={loading} failed={loadFailed} />
    </View>
  )
}

type BarButtonSpec = {
  icon: ComponentType<IconProps>
  accessibilityLabel: string
  onPress: () => void
  disabled?: boolean
}

function BarButton({ button, ref }: { button: BarButtonSpec; ref?: Ref<HostInstance> }) {
  const { icon: Icon } = button
  return (
    <Pressable
      ref={ref}
      collapsable={false}
      onPress={button.onPress}
      disabled={button.disabled}
      accessibilityRole="button"
      accessibilityLabel={button.accessibilityLabel}
      accessibilityState={{ disabled: button.disabled === true }}
      style={({ pressed }) => [
        styles.button,
        pressed && styles.pressed,
        button.disabled && styles.disabled
      ]}
    >
      <Icon size={20} color={colors.textPrimary} strokeWidth={2.2} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    zIndex: 20,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  rowEnd: {
    justifyContent: 'flex-end'
  },
  button: {
    width: BAR_CONTROL_SIZE,
    height: BAR_CONTROL_SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder
  },
  pressed: {
    opacity: feedback.pressedOpacity
  },
  disabled: {
    opacity: feedback.disabledOpacity
  },
  pill: {
    flex: 1,
    minWidth: 0,
    height: BAR_CONTROL_SIZE
  },
  pillField: {
    height: BAR_CONTROL_SIZE,
    minHeight: BAR_CONTROL_SIZE,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg
  },
  pillFieldReading: {
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder
  },
  // Covers the field's own text; the keyboard and reload slots sit over it at each end.
  pillLabel: {
    ...StyleSheet.absoluteFill,
    margin: StyleSheet.hairlineWidth,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: BAR_CONTROL_SIZE
  },
  pillText: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: COMPOSER_TEXT_SIZE,
    fontWeight: '500'
  },
  pillPlaceholder: {
    color: colors.textMuted,
    fontWeight: '400'
  },
  pillSlot: {
    position: 'absolute',
    top: 0,
    width: BAR_CONTROL_SIZE,
    height: BAR_CONTROL_SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pillSlotStart: { left: 0 },
  pillSlotEnd: { right: 0 }
}))
