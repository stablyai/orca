import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc-client'
import { triggerError, triggerSuccess } from '../../platform/haptics'
import { parseGitHubPrReference } from '../../source-control/github-pr-link-parse'
import { linkMobilePr } from '../../source-control/mobile-pr-link'
import { BottomDrawer } from '../BottomDrawer'

type Props = {
  visible: boolean
  client: RpcClient | null
  worktreeId: string
  onClose: () => void
  onLinked: () => void
}

// Link an existing PR to this worktree by number or GitHub URL, mirroring desktop's
// "Link another PR". The number/URL is parsed with the same rules as desktop; Link
// is disabled until it parses. On success we persist via worktree.set and refetch.
export function MobileLinkPrSheet({ visible, client, worktreeId, onClose, onLinked }: Props) {
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (visible) {
      setInput('')
      setError(null)
    }
  }, [visible])

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
    <BottomDrawer visible={visible} onClose={onClose}>
      <View>
        <Text style={styles.heading}>Link existing pull request</Text>
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
            <Text style={styles.submitText}>
              {parsed ? `Link #${parsed}` : 'Link pull request'}
            </Text>
          )}
        </Pressable>
      </View>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  heading: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700',
    marginBottom: spacing.sm
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
