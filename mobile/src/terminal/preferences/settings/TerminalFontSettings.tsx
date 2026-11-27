import { Text, View } from 'react-native'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { hostOs } from '../../../platform/host-os'
import { ListRow } from '../../../components/list/ListGroup'
import { MobileSlider } from '../../../components/controls/MobileSlider'
import {
  MobileSegmentedControl,
  type MobileSegment
} from '../../../components/controls/MobileSegmentedControl'
import { PickerModal, type PickerOption } from '../../../components/sheets/PickerModal'
import { SettingsSection } from '../../../settings/settings-screen-frame'
import { spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../theme/themed-styles'
import {
  TERMINAL_FONT_WEIGHTS,
  TERMINAL_LINE_HEIGHTS,
  type TerminalFontId
} from '../terminal-font-style'
import {
  TERMINAL_MAX_FONT_PX,
  TERMINAL_MIN_FONT_PX,
  terminalFontPxForScale,
  terminalTextScaleForPx
} from '../terminal-text-scales'
import type { TerminalFontSettings } from '../use-terminal-font-settings'

function fontOptions(t: Translate): PickerOption<TerminalFontId>[] {
  const onDevice = t('app.terminalSettings.fontsOnDevice', 'On this device')
  const included = t('app.terminalSettings.fontsIncluded', 'Included with Orca')
  // The phone's OS, not the page's 'web': the session's Text size sheet lists these fonts too.
  const ios = hostOs() === 'ios'
  return [
    {
      value: 'system',
      label: ios ? 'SF Mono' : t('app.terminalSettings.systemMono', 'System mono'),
      subtitle: t('app.terminalSettings.defaultFont', 'Default'),
      section: onDevice
    },
    ...(ios ? [{ value: 'menlo' as const, label: 'Menlo', section: onDevice }] : []),
    { value: 'courier-new', label: 'Courier New', section: onDevice },
    { value: 'jetbrains-mono', label: 'JetBrains Mono', section: included },
    { value: 'fira-code', label: 'Fira Code', section: included },
    { value: 'geist-mono', label: 'Geist Mono', section: included }
  ]
}

export function terminalFontLabel(font: TerminalFontId, t: Translate): string {
  return fontOptions(t).find((option) => option.value === font)?.label ?? 'Menlo'
}

function lineSpacingSegments(t: Translate): MobileSegment<string>[] {
  const labels = [
    t('app.terminalSettings.lineSpacingTight', 'Tight'),
    t('app.terminalSettings.lineSpacingNormal', 'Normal'),
    t('app.terminalSettings.lineSpacingRoomy', 'Roomy')
  ]
  return TERMINAL_LINE_HEIGHTS.map((value, index) => ({
    value: String(value),
    label: labels[index]!
  }))
}

function weightSegments(t: Translate): MobileSegment<string>[] {
  const labels = [
    t('app.terminalSettings.weightLight', 'Light'),
    t('app.terminalSettings.weightRegular', 'Regular'),
    t('app.terminalSettings.weightMedium', 'Medium')
  ]
  return TERMINAL_FONT_WEIGHTS.map((value, index) => ({
    value: String(value),
    label: labels[index]!
  }))
}

/** Font, size, line spacing and weight rows; the picker sheet renders at the screen root. */
export function TerminalFontSection({
  settings,
  onOpenFontPicker
}: {
  settings: TerminalFontSettings
  onOpenFontPicker: () => void
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const { fontStyle, selectFontStyle } = settings
  const px = terminalFontPxForScale(settings.textScale)
  const pointsLabel = terminalPointsLabel(px, t)
  return (
    <SettingsSection
      first
      footer={t('app.terminalSettings.pinchFooter', 'Pinch in a terminal to change the size.')}
    >
      <ListRow
        key="font"
        title={t('app.terminalSettings.font', 'Font')}
        value={terminalFontLabel(fontStyle.font, t)}
        navigates
        onPress={onOpenFontPicker}
      />
      <TerminalTextSizeRow
        key="size"
        px={px}
        value={pointsLabel}
        onPreview={(next) => settings.previewTextScale(terminalTextScaleForPx(next))}
        onCommit={(next) => settings.selectTextScale(terminalTextScaleForPx(next))}
      />
      <View key="lineSpacing" style={styles.row}>
        <Text style={styles.title}>{t('app.terminalSettings.lineSpacing', 'Line spacing')}</Text>
        <MobileSegmentedControl
          fill
          segments={lineSpacingSegments(t)}
          selected={String(fontStyle.lineHeight)}
          onSelect={(value) => selectFontStyle({ ...fontStyle, lineHeight: Number(value) })}
          testIDPrefix="terminal-line-spacing-"
        />
      </View>
      <View key="weight" style={styles.row}>
        <Text style={styles.title}>{t('app.terminalSettings.weight', 'Weight')}</Text>
        <MobileSegmentedControl
          fill
          segments={weightSegments(t)}
          selected={String(fontStyle.weight)}
          onSelect={(value) => selectFontStyle({ ...fontStyle, weight: Number(value) })}
          testIDPrefix="terminal-weight-"
        />
      </View>
    </SettingsSection>
  )
}

export function terminalPointsLabel(px: number, t: Translate): string {
  return t('app.terminalSettings.sizePoints', '{{size}} pt', { size: px })
}

/** The size row: a slider whose drag previews each step and commits on release. */
export function TerminalTextSizeRow({
  px,
  value,
  onPreview,
  onCommit
}: {
  px: number
  /** Shown beside the title, e.g. "13 pt". */
  value: string
  onPreview: (px: number) => void
  onCommit: (px: number) => void
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <Text style={styles.title}>{t('app.terminalSettings.size', 'Size')}</Text>
        <Text style={styles.value}>{value}</Text>
      </View>
      <View style={styles.sliderLine}>
        <Text style={[styles.sizeMark, styles.sizeMarkSmall]}>A</Text>
        <View style={styles.slider}>
          <MobileSlider
            value={px}
            min={TERMINAL_MIN_FONT_PX}
            max={TERMINAL_MAX_FONT_PX}
            onValueChange={onPreview}
            onSlidingComplete={onCommit}
            accessibilityLabel={t('app.terminalSettings.size', 'Size')}
            accessibilityValueText={terminalPointsLabel(px, t)}
          />
        </View>
        <Text style={[styles.sizeMark, styles.sizeMarkLarge]}>A</Text>
      </View>
    </View>
  )
}

/** The terminal font sheet: system fonts first, then the ones Orca ships. Picking closes it. */
export function TerminalFontPicker({
  visible,
  settings,
  onClose
}: {
  visible: boolean
  settings: Pick<TerminalFontSettings, 'fontStyle' | 'selectFontStyle'>
  onClose: () => void
}) {
  const t = useMobileTranslation()
  return (
    <PickerModal<TerminalFontId>
      visible={visible}
      title={t('app.terminalSettings.fontPickerTitle', 'Terminal font')}
      options={fontOptions(t)}
      selected={settings.fontStyle.font}
      onSelect={(font) => settings.selectFontStyle({ ...settings.fontStyle, font })}
      onClose={onClose}
    />
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm
  },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  title: { fontSize: 15, color: colors.textPrimary },
  value: { fontSize: 15, color: colors.textSecondary },
  sliderLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  slider: { flex: 1 },
  sizeMark: { color: colors.textSecondary },
  sizeMarkSmall: { fontSize: 12 },
  sizeMarkLarge: { fontSize: 20 }
}))
