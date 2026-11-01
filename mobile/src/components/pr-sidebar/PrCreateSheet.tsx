import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronsUpDown, Sparkles } from 'lucide-react-native'
import { colors, pressedStyle, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { triggerError, triggerSuccess } from '../../platform/haptics'
import { SheetHeader } from '../nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../SheetPrimaryButton'
import { ListGroup, ListRow } from '../list/ListGroup'
import { MobileSwitch } from '../MobileSwitch'
import { normalizeHostedReviewHeadRef } from '../../../../src/shared/hosted-review-refs'
import { hostedReviewCopy } from '../../source-control/hosted-review-copy'
import {
  mobileHostedReviewCreateIntentProgressMessage,
  type MobileHostedReviewCreateIntentProgress
} from '../../source-control/mobile-hosted-review-create-intent'
import {
  isMobileHostedReviewCommitFailure,
  runMobileHostedReviewCreateIntent
} from '../../source-control/mobile-hosted-review-create-intent-runner'
import {
  cancelMobilePrFields,
  generateMobilePrFields,
  loadMobilePrCreateDraft,
  type MobilePrCreateDraft
} from '../../source-control/mobile-pr-create-draft'
import {
  getMobileCommitFailureStagedEntries,
  type MobileCommitFailureRecovery
} from '../../source-control/mobile-commit-failure-recovery'
import { useMobileCommitFailureRecovery } from '../../source-control/use-mobile-commit-failure-recovery'
import { MobileCommitFailurePanel } from '../../source-control/MobileCommitFailurePanel'
import type { MobilePrTab } from './use-mobile-pr-tab'
import { prSheetStyles as sheetStyles } from './pr-tab-styles'
import { PrBasePicker } from './PrBasePicker'
import { FieldTextInput } from '../composer-input/FieldTextInput'

type Fields = { title: string; body: string; base: string; draft: boolean }

// One Create flow for every entry point and all five providers: seed from commits, push if needed, land on the PR tab.
export function PrCreateSheet({ tab }: { tab: MobilePrTab }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { client, worktreeId, gitBranch } = tab
  const creating = tab.creatingPr
  const setCreating = tab.setCreatingPr
  const [draft, setDraft] = useState<MobilePrCreateDraft | null>(null)
  const [fields, setFields] = useState<Fields | null>(null)
  const [pickingBase, setPickingBase] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [commitFailure, setCommitFailure] = useState<MobileCommitFailureRecovery | null>(null)
  const commitFailureAction = useMobileCommitFailureRecovery({
    client,
    connState: tab.connState,
    worktreeId,
    workspaceLabel: tab.workspaceLabel,
    failure: commitFailure
  })
  const statusRef = useRef(tab.gitStatus)
  useLayoutEffect(() => {
    statusRef.current = tab.gitStatus
  })
  const commitsAheadRef = useRef(tab.commitsAhead)
  useLayoutEffect(() => {
    commitsAheadRef.current = tab.commitsAhead
  })
  // Seed once per open: a reconnect or a status reload must not overwrite what the user typed.
  const seededRef = useRef(false)

  useEffect(() => {
    if (!client || !gitBranch || seededRef.current) {
      return
    }
    let cancelled = false
    void loadMobilePrCreateDraft(client, worktreeId, {
      branch: gitBranch,
      status: statusRef.current,
      commitsAhead: commitsAheadRef.current
    })
      .then((loaded) => {
        if (!cancelled) {
          seededRef.current = true
          setDraft(loaded)
          setFields({ title: loaded.title, body: loaded.body, base: loaded.base, draft: false })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setMessage({ text: err instanceof Error ? err.message : String(err), error: true })
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, gitBranch, worktreeId])

  const copy = hostedReviewCopy(draft?.prefill.provider)
  const title = t('pullRequest.createSheet.title', 'Create {{reviewLabel}}', {
    reviewLabel: copy.reviewLabel
  })
  const update = (patch: Partial<Fields>) =>
    setFields((current) => (current ? { ...current, ...patch } : current))

  // Closing the sheet cancels a running generation on the host and drops its late answer; a reconnect does neither.
  const generationRef = useRef(0)
  const generatingRef = useRef(false)
  useLayoutEffect(() => {
    generatingRef.current = generating
  })
  const cancelTargetRef = useRef({ client, worktreeId })
  useLayoutEffect(() => {
    cancelTargetRef.current = { client, worktreeId }
  })
  useEffect(
    () => () => {
      generationRef.current += 1
      const target = cancelTargetRef.current
      if (generatingRef.current && target.client) {
        void cancelMobilePrFields(target.client, target.worktreeId).catch(() => {})
      }
    },
    []
  )

  const writeWithAi = async () => {
    if (!client || !fields || !draft || generating) {
      return
    }
    const generation = ++generationRef.current
    setGenerating(true)
    setMessage(null)
    try {
      const result = await generateMobilePrFields(client, worktreeId, {
        ...fields,
        provider: draft.prefill.provider
      })
      if (generation !== generationRef.current) {
        return
      }
      if (result.success) {
        update({ title: result.fields.title || fields.title, body: result.fields.body })
      } else if (!result.canceled) {
        setMessage({ text: result.error, error: true })
      }
    } catch (err) {
      if (generation === generationRef.current) {
        setMessage({ text: err instanceof Error ? err.message : String(err), error: true })
      }
    } finally {
      if (generation === generationRef.current) {
        setGenerating(false)
      }
    }
  }

  // A second tap can land before `creating` re-renders, so a ref guards the push-and-create.
  const createInFlightRef = useRef(false)
  const create = async () => {
    if (!client || !gitBranch || !fields || creating || createInFlightRef.current) {
      return
    }
    createInFlightRef.current = true
    setCreating(true)
    setMessage(null)
    setCommitFailure(null)
    tab.beforeCreate?.()
    let progress: MobileHostedReviewCreateIntentProgress | null = null
    try {
      const outcome = await runMobileHostedReviewCreateIntent(client, worktreeId, {
        branch: gitBranch,
        title: fields.title,
        fields,
        status: statusRef.current,
        commitMessage: tab.readCommitMessage?.(),
        readCommitMessage: tab.readCommitMessage,
        onProgress: (next) => {
          progress = next
          setMessage({ text: mobileHostedReviewCreateIntentProgressMessage(next), error: false })
        }
      })
      if (!outcome.ok) {
        tab.onCreateSettled?.({ created: null, committed: outcome.committed === true })
        triggerError()
        if (isMobileHostedReviewCommitFailure(outcome, progress)) {
          setCommitFailure({
            error: outcome.error,
            commitMessage: outcome.commitMessage ?? fields.title,
            stagedEntries: getMobileCommitFailureStagedEntries(
              outcome.status?.entries ?? statusRef.current?.entries
            )
          })
        }
        setMessage({ text: outcome.error, error: true })
        return
      }
      triggerSuccess()
      setCreating(false)
      const created = {
        url: outcome.url,
        warning: outcome.warning ?? null,
        provider: outcome.prefill.provider,
        committed: outcome.committed
      }
      // A Created notice is another modal, so it waits for this sheet to finish closing.
      tab.closeSheetThen(() => tab.onCreateSettled?.({ created, committed: outcome.committed }))
    } catch (err) {
      triggerError()
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true })
    } finally {
      createInFlightRef.current = false
      setCreating(false)
    }
  }

  if (pickingBase && fields) {
    return (
      <PrBasePicker
        tab={tab}
        current={fields.base}
        onPick={(base) => {
          update({ base })
          setPickingBase(false)
        }}
        onBack={() => setPickingBase(false)}
      />
    )
  }

  return (
    <View>
      <SheetHeader
        title={title}
        subtitle={gitBranch ? normalizeHostedReviewHeadRef(gitBranch) : undefined}
        leading={{
          label: t('common.cancel', 'Cancel'),
          onPress: tab.closeSheet,
          disabled: creating
        }}
      />
      {!fields ? (
        <View style={styles.loading}>
          {!gitBranch ? (
            <Text style={sheetStyles.note}>
              {t(
                'pullRequest.prSidebarCreateEmptyState.branchRequired',
                'Check out a branch before creating a pull request.'
              )}
            </Text>
          ) : message ? (
            <Text style={sheetStyles.error}>{message.text}</Text>
          ) : (
            <ActivityIndicator color={colors.textSecondary} />
          )}
        </View>
      ) : (
        <View style={sheetStyles.body}>
          <View style={styles.field}>
            <Text style={styles.label}>{t('pullRequest.createSheet.titleLabel', 'Title')}</Text>
            <FieldTextInput
              value={fields.title}
              onChangeText={(value) => update({ title: value })}
              // Write with AI rewrites the title too, so it is locked until the answer lands.
              editable={!creating && !generating}
              multiline
              style={sheetStyles.field}
              accessibilityLabel={t('pullRequest.createSheet.titleLabel', 'Title')}
            />
          </View>
          <View style={styles.field}>
            <View style={styles.labelRow}>
              <Text style={styles.label}>
                {t('pullRequest.createSheet.descriptionLabel', 'Description')}
              </Text>
              <Pressable
                onPress={() => void writeWithAi()}
                disabled={generating || creating}
                hitSlop={8}
                accessibilityRole="button"
                style={({ pressed }) => [styles.aiButton, pressed && pressedStyle]}
              >
                {generating ? (
                  <ActivityIndicator size="small" color={colors.textPrimary} />
                ) : (
                  <Sparkles size={13} color={colors.textPrimary} strokeWidth={2.2} />
                )}
                <Text style={styles.aiLabel}>
                  {t('pullRequest.createSheet.writeWithAi', 'Write with AI')}
                </Text>
              </Pressable>
            </View>
            <FieldTextInput
              value={fields.body}
              onChangeText={(value) => update({ body: value })}
              editable={!creating && !generating}
              multiline
              placeholder={t('pullRequest.createSheet.descriptionPlaceholder', 'Optional')}
              style={[sheetStyles.field, sheetStyles.multiline]}
              accessibilityLabel={t('pullRequest.createSheet.descriptionLabel', 'Description')}
            />
          </View>
          <ListGroup>
            <ListRow
              key="base"
              title={t('pullRequest.createSheet.base', 'Base')}
              value={fields.base}
              accessory={<ChevronsUpDown size={14} color={colors.textMuted} strokeWidth={2.2} />}
              onPress={() => setPickingBase(true)}
              // Generated text describes the base it was asked about, so the base waits for it.
              disabled={creating || generating}
            />
            <ListRow
              key="draft"
              title={t('pullRequest.createSheet.draft', 'Create as draft')}
              accessory={
                <MobileSwitch
                  value={fields.draft}
                  onValueChange={(value) => update({ draft: value })}
                  disabled={creating}
                  accessibilityLabel={t('pullRequest.createSheet.draft', 'Create as draft')}
                />
              }
            />
          </ListGroup>
          {commitFailure ? (
            <MobileCommitFailurePanel failure={commitFailure} action={commitFailureAction} />
          ) : message ? (
            <Text style={message.error ? sheetStyles.error : sheetStyles.note}>{message.text}</Text>
          ) : null}
          <SheetPrimaryButton
            label={title}
            busy={creating}
            disabled={fields.title.trim().length === 0 || !fields.base.trim() || generating}
            onPress={() => void create()}
          />
        </View>
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  loading: { padding: spacing.xl, alignItems: 'center' },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  aiButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  aiLabel: { fontSize: 13, fontWeight: '600', color: colors.textPrimary }
}))
