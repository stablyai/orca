import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View
} from 'react-native'
import { Sparkles } from 'lucide-react-native'
import type { HostedReviewProvider } from '../../../src/shared/hosted-review'
import { BottomDrawer } from './BottomDrawer'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { createMobilePr } from '../source-control/mobile-pr-create'

type PrPrefill = {
  base: string
  title: string
  body: string
  provider: HostedReviewProvider
}

type Props = {
  visible: boolean
  client: RpcClient | null
  worktreeId: string
  prefill: PrPrefill
  onClose: () => void
  onCreated: (url: string) => void
}

// PR compose sheet: title/body/base/draft with AI prefill (git.generate
// PullRequestFields), submitting via hostedReview.create. Mirrors the desktop
// CreateHostedReviewComposer flow at mobile scale.
export function MobilePrComposeSheet({
  visible,
  client,
  worktreeId,
  prefill,
  onClose,
  onCreated
}: Props) {
  const [title, setTitle] = useState(prefill.title)
  const [body, setBody] = useState(prefill.body)
  const [base, setBase] = useState(prefill.base)
  const [draft, setDraft] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (visible) {
      setTitle(prefill.title)
      setBody(prefill.body)
      setBase(prefill.base)
      setDraft(false)
      setError(null)
    }
    // Why: depend on the prefill *fields*, not the object identity — a parent
    // rerender that produces a new prefill object would otherwise wipe the
    // user's in-progress edits while the sheet is open.
  }, [visible, prefill.title, prefill.body, prefill.base])

  const generate = useCallback(async () => {
    if (!client || generating) {
      return
    }
    setGenerating(true)
    setError(null)
    try {
      const response = await client.sendRequest('git.generatePullRequestFields', {
        worktree: `id:${worktreeId}`,
        base,
        title,
        body,
        draft
      })
      if (!response.ok) {
        setError(response.error?.message || 'Failed to generate PR fields')
        return
      }
      const result = (response as RpcSuccess).result as {
        success?: boolean
        fields?: { base: string; title: string; body: string; draft: boolean }
        error?: string
      }
      if (result.success && result.fields) {
        setBase(result.fields.base || base)
        setTitle(result.fields.title || title)
        setBody(result.fields.body || body)
        setDraft(result.fields.draft)
      } else if (result.error) {
        setError(result.error)
      }
    } finally {
      setGenerating(false)
    }
  }, [base, body, client, draft, generating, title, worktreeId])

  const submit = useCallback(async () => {
    if (!client || submitting || title.trim().length === 0) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const outcome = await createMobilePr(client, worktreeId, {
        provider: prefill.provider,
        base,
        title,
        body,
        draft
      })
      if (outcome.ok) {
        triggerSuccess()
        onCreated(outcome.url)
      } else {
        triggerError()
        setError(outcome.error)
      }
    } finally {
      setSubmitting(false)
    }
  }, [base, body, client, draft, onCreated, prefill.provider, submitting, title, worktreeId])

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
        <Text style={styles.heading}>Create Pull Request</Text>
        <View style={styles.fieldRow}>
          <Text style={styles.label}>Title</Text>
          <Pressable
            style={({ pressed }) => [styles.genButton, pressed && styles.genButtonPressed]}
            disabled={generating || submitting}
            onPress={() => void generate()}
            accessibilityLabel="Generate PR fields with AI"
          >
            {generating ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <Sparkles size={14} color={colors.textSecondary} strokeWidth={2.1} />
            )}
          </Pressable>
        </View>
        <TextInput
          style={styles.titleInput}
          value={title}
          onChangeText={setTitle}
          placeholder="Pull request title"
          placeholderTextColor={colors.textMuted}
          editable={!submitting}
        />
        <Text style={styles.label}>Base branch</Text>
        <TextInput
          style={styles.titleInput}
          value={base}
          onChangeText={setBase}
          placeholder="main"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          editable={!submitting}
        />
        <Text style={styles.label}>Description</Text>
        <TextInput
          style={styles.bodyInput}
          value={body}
          onChangeText={setBody}
          placeholder="Describe the change…"
          placeholderTextColor={colors.textMuted}
          multiline
          editable={!submitting}
        />
        <View style={styles.draftRow}>
          <Text style={styles.label}>Draft</Text>
          <Switch value={draft} onValueChange={setDraft} disabled={submitting} />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable
          style={({ pressed }) => [
            styles.submit,
            (submitting || title.trim().length === 0) && styles.submitDisabled,
            pressed && styles.submitPressed
          ]}
          disabled={submitting || title.trim().length === 0}
          onPress={() => void submit()}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <Text style={styles.submitText}>Create Pull Request</Text>
          )}
        </Pressable>
      </ScrollView>
    </BottomDrawer>
  )
}

export function openMobilePrUrl(url: string): void {
  void Linking.openURL(url)
}

const styles = StyleSheet.create({
  scroll: { maxHeight: 460 },
  heading: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700',
    marginBottom: spacing.sm
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  label: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginTop: spacing.md,
    marginBottom: spacing.xs
  },
  genButton: {
    width: 32,
    height: 32,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm
  },
  genButtonPressed: { opacity: 0.7 },
  titleInput: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  bodyInput: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    minHeight: 96,
    textAlignVertical: 'top'
  },
  draftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md
  },
  error: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    marginTop: spacing.md
  },
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
  submitText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
