import { useCallback } from 'react'
import { useRouter } from 'expo-router'
import { FileText } from 'lucide-react-native'
import { Pressable, StyleSheet, Text } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

type MobileSourceControlReviewEntryProps = {
  readonly count: number
  readonly disabled: boolean
  readonly hostId: string
  readonly worktreeId: string
  readonly worktreeName: string
}

export function MobileSourceControlReviewEntry({
  count,
  disabled,
  hostId,
  worktreeId,
  worktreeName
}: MobileSourceControlReviewEntryProps) {
  const router = useRouter()
  const canOpenReview = count > 0 && !disabled

  const openReviewChanges = useCallback(() => {
    if (!canOpenReview) {
      return
    }
    const params = new URLSearchParams()
    params.set('scope', 'all')
    params.set('origin', 'source-control')
    if (worktreeName) {
      params.set('name', worktreeName)
    }
    const query = params.toString()
    router.push(
      `/h/${encodeURIComponent(hostId)}/review/${encodeURIComponent(worktreeId)}?${query}`
    )
  }, [canOpenReview, hostId, router, worktreeId, worktreeName])

  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        !canOpenReview && styles.disabled,
        pressed && canOpenReview && styles.pressed
      ]}
      onPress={openReviewChanges}
      disabled={!canOpenReview}
      accessibilityRole="button"
      accessibilityLabel="Review changes"
    >
      <FileText size={15} color={colors.bgBase} strokeWidth={2.2} />
      <Text style={styles.text}>Review Changes</Text>
      <Text style={styles.count}>{count}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    minHeight: 42,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md
  },
  disabled: {
    opacity: 0.45
  },
  pressed: {
    opacity: 0.78
  },
  text: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  count: {
    marginLeft: spacing.xs,
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '700'
  }
})
