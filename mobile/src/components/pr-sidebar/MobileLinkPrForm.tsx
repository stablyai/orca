import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc-client'
import { triggerError, triggerSuccess } from '../../platform/haptics'
import { parseGitHubPrReference } from '../../source-control/github-pr-link-parse'
import { linkMobilePr } from '../../source-control/mobile-pr-link'

type Props = {
  client: RpcClient | null
  worktreeId: string
  onCancel: () => void
  onLinked: () => void
}

// Link-an-existing-PR form body (number or GitHub URL). Renders a plain View so
// it can sit inline inside the PR sidebar's ScrollView, mirroring the compose
// form fix — a BottomDrawer overlay nested in a ScrollView gets clipped.
export function MobileLinkPrForm({ client, worktreeId, onCancel, onLinked }: Props) {
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = parseGitHubPrReference(input)

  const submit = useCallback(async () => {
    if (!client || submitting || parsed === null) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const outcome = await linkMobilePr(client, worktreeId, parsed)
      if (outcome.ok) {
        triggerSuccess()
        onLinked()
      } else {
        triggerError()
        setError(outcome.error)
      }
    } finally {
      setSubmitting(false)
    }
  }, [client, onLinked, parsed, submitting, worktreeId])

  return (
    <View>
      <View style={styles.headingRow}>
        <Text style={styles.heading}>Link existing pull request</Text>
        <Pressable
          onPress={onCancel}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          hitSlop={8}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
      <Text style={styles.label}>PR number or GitHub URL</Text>
      <TextInput
        style={styles.input}
        value={input}
        onChangeText={setInput}
        placeholder="#123 or https://github.com/owner/repo/pull/123"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!submitting}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        style={({ pressed }) => [
          styles.submit,
          (submitting || parsed === null) && styles.submitDisabled,
          pressed && styles.submitPressed
        ]}
        disabled={submitting || parsed === null}
        onPress={() => void submit()}
      >
        {submitting ? (
          <ActivityIndicator size="small" color={colors.bgBase} />
        ) : (
          <Text style={styles.submitText}>{parsed ? `Link #${parsed}` : 'Link pull request'}</Text>
        )}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm
  },
  heading: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  label: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginTop: spacing.sm,
    marginBottom: spacing.xs
  },
  input: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  error: { color: colors.statusRed, fontSize: typography.metaSize, marginTop: spacing.md },
  submit: {
    marginTop: spacing.lg,
    minHeight: 46,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center'
  },
  submitDisabled: { opacity: 0.45 },
  submitPressed: { opacity: 0.8 },
  submitText: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '600' }
})
