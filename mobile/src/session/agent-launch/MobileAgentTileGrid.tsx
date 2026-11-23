import { Pressable, Text, View } from 'react-native'
import { MobileAgentIcon } from '../../components/icons/MobileAgentIcon'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'

const AGENT_GRID_COLUMNS = 3

/** The agents a sheet can start, as tiles three to a row. */
export function MobileAgentTileGrid({
  options,
  showCliOnly,
  onPick
}: {
  options: readonly MobileNewTabAgentOption[]
  /** Notes tiles whose agent the host can only start as a CLI. */
  showCliOnly: boolean
  onPick: (option: MobileNewTabAgentOption) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Short last rows keep empty slots so every tile stays a third of the row wide.
  const rows: { options: MobileNewTabAgentOption[]; emptySlots: string[] }[] = []
  for (let start = 0; start < options.length; start += AGENT_GRID_COLUMNS) {
    const rowOptions = options.slice(start, start + AGENT_GRID_COLUMNS)
    const emptySlots: string[] = []
    for (let column = rowOptions.length; column < AGENT_GRID_COLUMNS; column += 1) {
      emptySlots.push(`empty:${column}`)
    }
    rows.push({ options: rowOptions, emptySlots })
  }
  return (
    <View style={styles.grid}>
      {rows.map((row) => (
        <View key={row.options.map((option) => option.agent).join(':')} style={styles.gridRow}>
          {row.options.map((option) => (
            <Pressable
              key={option.agent}
              onPress={() => onPick(option)}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              style={styles.tile}
            >
              {({ pressed }) => (
                <>
                  {pressed ? <View style={styles.tilePressed} /> : null}
                  <MobileAgentIcon agentId={option.agent} size={22} />
                  <Text style={styles.tileLabel} numberOfLines={1}>
                    {option.label}
                  </Text>
                  {showCliOnly && option.cliOnly ? (
                    <Text style={styles.tileNote} numberOfLines={1}>
                      {t('session.sheets.cliOnly', 'CLI only')}
                    </Text>
                  ) : null}
                </>
              )}
            </Pressable>
          ))}
          {row.emptySlots.map((slot) => (
            <View key={slot} style={styles.tileSpacer} />
          ))}
        </View>
      ))}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  grid: { gap: spacing.sm },
  gridRow: { flexDirection: 'row', gap: spacing.sm },
  tile: {
    flex: 1,
    minWidth: 0,
    height: 78,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm
  },
  // Same wash as a pressed ListRow, laid over the tile so its own fill stays underneath.
  tilePressed: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.translucentFill
  },
  tileLabel: { fontSize: 13.5, fontWeight: '600', color: colors.textPrimary, maxWidth: '100%' },
  // Sits in the tile's gap, so a noted tile keeps the others' height.
  tileNote: { fontSize: 11, color: colors.textMuted, marginTop: -spacing.xs, maxWidth: '100%' },
  // Padded like a tile: flex shares space after padding, so a bare spacer would widen its row's tiles.
  tileSpacer: { flex: 1, paddingHorizontal: spacing.sm }
}))
