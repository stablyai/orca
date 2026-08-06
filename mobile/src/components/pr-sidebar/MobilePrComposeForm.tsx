import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, Switch, Text, TextInput, View } from 'react-native'
import {
  ArrowRight,
  GitMerge,
  GitPullRequestArrow,
  Sparkles,
  TriangleAlert,
  X
} from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc-client'
import type { RpcSuccess } from '../../transport/types'
import { triggerError, triggerSuccess } from '../../platform/haptics'
import {
  createMobilePr,
  getMobilePrCreateSuccessWarning,
  shouldPushBeforeMobilePrCreate,
  type MobilePrPrefill
} from '../../source-control/mobile-pr-create'
import { hostedReviewCopy } from '../../source-control/hosted-review-copy'
import {
  getPrComposeDisabledReason,
  isBaseHeadDistinct
} from '../../source-control/pr-compose-validation'
import { MobilePrBasePicker } from '../MobilePrBasePicker'
import { mobilePrComposeFormStyles as styles } from './mobile-pr-compose-form-styles'
import { t } from '@/i18n/mobile-i18n'

export type PrComposePrefill = MobilePrPrefill

type Props = {
  client: RpcClient | null
  worktreeId: string
  prefill: PrComposePrefill
  // Head branch — enables the base≠head guard and the "from <branch>" hint.
  head?: string | null
  onCancel: () => void
  onCreated: (url: string, warning?: string) => void
}

// PR compose form body: title/body/base/draft with AI prefill (git.generate
// PullRequestFields), submitting via createMobilePr. Renders a plain View so it
// can sit inline inside the PR sidebar's existing ScrollView (a BottomDrawer
// overlay trapped in a ScrollView clips the form). The BottomDrawer wrapper
// MobilePrComposeSheet reuses this body at full-screen roots.
export function MobilePrComposeForm({
  client,
  worktreeId,
  prefill,
  head,
  onCancel,
  onCreated
}: Props) {
  const copy = hostedReviewCopy(prefill.provider)
  const ReviewIcon = prefill.provider === 'gitlab' ? GitMerge : GitPullRequestArrow
  const [title, setTitle] = useState(prefill.title)
  const [body, setBody] = useState(prefill.body)
  const [base, setBase] = useState(prefill.base)
  const [draft, setDraft] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pushBeforeCreate = shouldPushBeforeMobilePrCreate(prefill)

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
        setError(response.error?.message || t('mobilePrComposeForm.failed'))
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
    } catch (err) {
      triggerError()
      setError(err instanceof Error ? err.message : t('mobilePrComposeForm.failed'))
    } finally {
      setGenerating(false)
    }
  }, [base, body, client, draft, generating, title, worktreeId])

  const headRef = head ?? ''
  const baseConflict = base.trim().length > 0 && !isBaseHeadDistinct(base, headRef)
  const submitDisabledReason = getPrComposeDisabledReason({
    title,
    base,
    head: headRef,
    generating,
    reviewLabel: copy.reviewLabel
  })
  const canSubmit = submitDisabledReason === null
  const fieldsLocked = submitting || generating

  const submit = useCallback(async () => {
    if (!client || submitting || !canSubmit) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const outcome = await createMobilePr(client, worktreeId, {
        provider: prefill.provider,
        base,
        // Send the same head the submit guard validated against, so the PR opens
        // from the validated branch instead of a host-inferred one.
        ...(head ? { head } : {}),
        title,
        body,
        draft,
        pushBeforeCreate
      })
      if (outcome.ok) {
        triggerSuccess()
        const warning = getMobilePrCreateSuccessWarning(outcome, prefill.provider)
        if (warning) {
          setError(warning)
        }
        onCreated(outcome.url, warning)
      } else {
        triggerError()
        setError(outcome.error)
      }
    } finally {
      setSubmitting(false)
    }
  }, [
    base,
    body,
    canSubmit,
    client,
    copy.titleLabel,
    draft,
    head,
    onCreated,
    prefill.provider,
    pushBeforeCreate,
    submitting,
    title,
    worktreeId
  ])

  return (
    <View style={styles.root}>
      <View style={styles.headingRow}>
        <View style={styles.headingTitle}>
          <ReviewIcon size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.heading}>
            {t('mobilePrComposeForm.new', {
              reviewType: copy.reviewLabel
            })}
          </Text>
        </View>
        <View style={styles.headingActions}>
          <Pressable
            style={({ pressed }) => [styles.genButton, pressed && styles.genButtonPressed]}
            disabled={generating || submitting}
            onPress={() => void generate()}
            accessibilityRole="button"
            accessibilityLabel={t('mobilePrComposeForm.generateReview', {
              reviewType: copy.reviewLabel
            })}
          >
            {generating ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <Sparkles size={13} color={colors.textSecondary} strokeWidth={2.1} />
            )}
            <Text style={styles.genButtonText}>
              {generating ? t('mobilePrComposeForm.generating') : t('mobilePrComposeForm.generate')}
            </Text>
          </Pressable>
          <Pressable
            style={styles.iconButton}
            onPress={onCancel}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel={t('mobilePrComposeForm.cancel')}
            hitSlop={8}
          >
            <X size={16} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
        </View>
      </View>

      {head ? (
        <View style={styles.branchFlow}>
          <Text style={styles.branchToken} numberOfLines={1}>
            {head}
          </Text>
          <ArrowRight size={12} color={colors.textSecondary} strokeWidth={2.2} />
          <Text
            style={[styles.branchToken, baseConflict && styles.branchTokenError]}
            numberOfLines={1}
          >
            {base || t('task.base')}
          </Text>
        </View>
      ) : null}

      <View style={styles.fieldStack}>
        <TextInput
          style={styles.titleInput}
          value={title}
          onChangeText={setTitle}
          placeholder={t('mobilePrComposeForm.title')}
          placeholderTextColor={colors.textMuted}
          editable={!fieldsLocked}
          accessibilityLabel={t('mobilePrComposeForm.reviewTypeTitle', {
            reviewType: copy.titleLabel
          })}
        />
        <TextInput
          style={styles.bodyInput}
          value={body}
          onChangeText={setBody}
          placeholder={t('mobilePrComposeForm.description')}
          placeholderTextColor={colors.textMuted}
          multiline
          editable={!fieldsLocked}
          accessibilityLabel={t('mobilePrComposeForm.reviewTypeDescription', {
            reviewType: copy.titleLabel
          })}
        />
      </View>

      {generating ? (
        <View style={styles.notice}>
          <Sparkles size={13} color={colors.textSecondary} strokeWidth={2.1} />
          <Text style={styles.noticeText}>{t('mobilePrComposeForm.generatingTitle')}</Text>
        </View>
      ) : null}

      <View style={styles.baseRow}>
        <Text style={styles.baseLabel}>{t('mobilePrComposeForm.base')}</Text>
        <View style={styles.baseControl}>
          <MobilePrBasePicker
            client={client}
            worktreeId={worktreeId}
            value={base}
            onChange={setBase}
            editable={!fieldsLocked}
          />
        </View>
      </View>

      <View style={styles.draftRow}>
        <Text style={styles.draftText}>{t('mobilePrComposeForm.createDraft')}</Text>
        <Switch value={draft} onValueChange={setDraft} disabled={fieldsLocked} />
      </View>
      {error || submitDisabledReason ? (
        <View style={styles.notice}>
          <TriangleAlert size={13} color={colors.statusRed} strokeWidth={2.1} />
          <Text style={[styles.noticeText, styles.errorText]}>{error ?? submitDisabledReason}</Text>
        </View>
      ) : null}
      <Pressable
        style={({ pressed }) => [
          styles.submit,
          (submitting || !canSubmit) && styles.submitDisabled,
          pressed && styles.submitPressed
        ]}
        disabled={submitting || !canSubmit}
        onPress={() => void submit()}
        accessibilityRole="button"
      >
        {submitting ? (
          <ActivityIndicator size="small" color={colors.bgBase} />
        ) : (
          <ReviewIcon size={14} color={colors.bgBase} strokeWidth={2.2} />
        )}
        <Text style={styles.submitText}>
          {pushBeforeCreate
            ? draft
              ? t('mobilePrComposeForm.pushCreateDraft', {
                  reviewType: copy.shortLabel
                })
              : t('mobilePrComposeForm.pushCreateReview', {
                  reviewType: copy.shortLabel
                })
            : draft
              ? t('mobilePrComposeForm.createDraftReview', {
                  reviewType: copy.shortLabel
                })
              : t('mobilePrComposeForm.createReview', {
                  reviewType: copy.shortLabel
                })}
        </Text>
      </Pressable>
    </View>
  )
}
