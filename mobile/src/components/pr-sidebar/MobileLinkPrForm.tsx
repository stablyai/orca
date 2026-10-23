import { useCallback, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, textStyles } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc-client'
import { triggerError, triggerSuccess } from '../../platform/haptics'
import { parseGitHubPrReference } from '../../source-control/github-pr-link-parse'
import { linkMobilePr } from '../../source-control/mobile-pr-link'
import { Button } from '../ui/Button'
import { TextField } from '../ui/TextField'

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
    <View style={styles.root}>
      <View style={styles.headingRow}>
        <Text style={styles.heading} accessibilityRole="header">
          Link existing pull request
        </Text>
        <Button
          label="Cancel"
          variant="plain"
          size="compact"
          onPress={onCancel}
          disabled={submitting}
        />
      </View>
      <TextField
        label="PR number or GitHub URL"
        value={input}
        onChangeText={setInput}
        placeholder="#123 or github.com/owner/repo/pull/123"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        editable={!submitting}
        footnote={error ?? undefined}
        error={error !== null}
        autoFocus
      />
      <Button
        label={parsed ? `Link #${parsed}` : 'Link pull request'}
        variant="primary"
        block
        busy={submitting}
        disabled={parsed === null}
        onPress={() => void submit()}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.lg
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  heading: {
    ...textStyles.headline,
    color: colors.textPrimary,
    flexShrink: 1
  }
})
