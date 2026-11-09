import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { normalizeHostedReviewHeadRef } from '../../../../src/shared/source-control/hosted-review/hosted-review-refs'
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
  loadMobilePrCreateDraft
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
import { workspaceDraftRowKey } from '../../drafts/durable-draft-rows'
import { updateDurableDraftField, useDurableDraftField } from '../../drafts/durable-draft-fields'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'

// The provider rides along so a kept draft reopens without asking the host again.
type Fields = { title: string; body: string; base: string; draft: boolean; provider: string }

// Every edit keeps the whole form. The provider is never empty, so it is what marks a kept draft.
function keepCreateFields(key: string, fields: Fields | null): void {
  updateDurableDraftField(key, 'provider', fields?.provider ?? '')
  updateDurableDraftField(key, 'title', fields?.title ?? '')
  updateDurableDraftField(key, 'body', fields?.body ?? '')
  updateDurableDraftField(key, 'base', fields?.base ?? '')
  updateDurableDraftField(key, 'draft', fields?.draft ? 'yes' : '')
}

function useKeptCreateFields(key: string | null): Fields | null {
  const [provider] = useDurableDraftField(key, 'provider')
  const [title] = useDurableDraftField(key, 'title')
  const [body] = useDurableDraftField(key, 'body')
  const [base] = useDurableDraftField(key, 'base')
  const [draft] = useDurableDraftField(key, 'draft')
  return useMemo(
    () => (provider ? { title, body, base, draft: draft === 'yes', provider } : null),
    [base, body, draft, provider, title]
  )
}

// One Create flow for every entry point and all five providers: seed from commits, push if needed, land on the PR tab.
export function PrCreateSheet({ tab }: { tab: MobilePrTab }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { client, hostId, worktreeId, gitBranch } = tab
  const executionHost = useWorkspaceExecutionHost()
  const creating = tab.creatingPr
  const setCreating = tab.setCreatingPr
  // What was typed waits, per workspace branch, through Cancel and the app being killed.
  const keptKey = gitBranch
    ? workspaceDraftRowKey('prCreate', { hostId, executionHost, worktreeId }, gitBranch)
    : null
  const kept = useKeptCreateFields(keptKey)
  const [seeded, setSeeded] = useState<Fields | null>(null)
  const [seedError, setSeedError] = useState<string | null>(null)
  const fields = kept ?? seeded
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
  // Seed once per open, and not over a kept draft: a reconnect or a status reload must not overwrite what was typed.
  const seedRef = useRef(kept !== null)

  useEffect(() => {
    if (!client || !gitBranch || seedRef.current) {
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
          seedRef.current = true
          setSeeded({
            title: loaded.title,
            body: loaded.body,
            base: loaded.base,
            draft: false,
            provider: loaded.prefill.provider
          })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSeedError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, gitBranch, worktreeId])

  const copy = hostedReviewCopy(fields?.provider)
  const title = t('pullRequest.createSheet.title', 'Create {{reviewLabel}}', {
    reviewLabel: copy.reviewLabel
  })
  // The first edit turns the seeded fields into a kept draft.
  const update = (patch: Partial<Fields>) => {
    if (keptKey && fields) {
      keepCreateFields(keptKey, { ...fields, ...patch })
    }
  }

  // Closing the sheet cancels a running generation, drops its late answer and keeps typed fields; a reconnect does none.
  const generationRef = useRef(0)
  const generatingRef = useRef(false)
  useLayoutEffect(() => {
    generatingRef.current = generating
  })
  const closeTargetRef = useRef({ client, worktreeId })
  useLayoutEffect(() => {
    closeTargetRef.current = { client, worktreeId }
  })
  useEffect(
    () => () => {
      generationRef.current += 1
      const target = closeTargetRef.current
      if (generatingRef.current && target.client) {
        void cancelMobilePrFields(target.client, target.worktreeId).catch(() => {})
      }
    },
    []
  )

  const writeWithAi = async () => {
    if (!client || !fields || generating) {
      return
    }
    const generation = ++generationRef.current
    setGenerating(true)
    setMessage(null)
    try {
      const result = await generateMobilePrFields(client, worktreeId, fields)
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
    const createdKey = keptKey
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
      // The PR exists now, so nothing carries over to the next Create on this branch, even when a branch or
      // client change closed this sheet mid-run.
      setSeeded(fields)
      if (createdKey) {
        keepCreateFields(createdKey, null)
      }
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
          ) : seedError ? (
            <Text style={sheetStyles.error}>{seedError}</Text>
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
