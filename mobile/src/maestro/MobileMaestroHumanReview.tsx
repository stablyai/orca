import { useMemo, useState } from 'react'
import * as ExpoCrypto from 'expo-crypto'
import { Pressable, Text, TextInput, View } from 'react-native'
import type { MaestroHumanReview } from '../../../src/shared/maestro-human-review'
import type { WorkspaceSurfaceSnapshot } from '../../../src/shared/maestro-workspace-canvas'
import type {
  MobileMaestroHumanReviewResource,
  MobileMaestroHumanReviewTransitionInput
} from './mobile-maestro-human-review'
import { mobileMaestroHumanReviewStyles as styles } from './mobile-maestro-human-review-styles'
import { colors } from '../theme/mobile-theme'

const APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1_000

const STATE_LABELS: Record<MaestroHumanReview['state'], string> = {
  staged: 'Staged',
  needs_input: 'Needs input',
  approved_for_submit: 'Approved for submit',
  submitted: 'Submitted',
  rejected: 'Rejected',
  expired: 'Approval expired'
}

type Props = {
  resource: MobileMaestroHumanReviewResource
  snapshot: WorkspaceSurfaceSnapshot
  onOpenExactTab: (surface: WorkspaceSurfaceSnapshot['surfaces'][string]) => void
}

function receiptId(action: string): string {
  return `${action}-${ExpoCrypto.randomUUID()}`
}

export function MobileMaestroHumanReview({ resource, snapshot, onOpenExactTab }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = useMemo(
    () => resource.reviews.find((review) => review.review_id === selectedId) ?? null,
    [resource.reviews, selectedId]
  )

  return (
    <View accessibilityLabel="Application review" style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.eyebrow}>Application review</Text>
        {resource.status === 'ready' ? (
          <Text style={styles.count}>{resource.reviews.length}</Text>
        ) : null}
      </View>
      <ReviewList resource={resource} selectedId={selectedId} onSelect={setSelectedId} />
      {selected ? (
        <ReviewDetail
          key={selected.review_id}
          review={selected}
          resource={resource}
          snapshot={snapshot}
          onOpenExactTab={onOpenExactTab}
        />
      ) : null}
    </View>
  )
}

function ReviewList({
  resource,
  selectedId,
  onSelect
}: {
  resource: MobileMaestroHumanReviewResource
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  if (resource.status === 'loading') {
    return <StatePanel title="Loading review items" detail="Waiting for the Run authority…" />
  }
  if (resource.status === 'unavailable' || resource.status === 'error') {
    return (
      <View accessibilityRole="alert" style={styles.statePanel}>
        <Text style={styles.stateTitle}>Review items are unavailable</Text>
        <Text style={styles.muted}>{resource.message}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void resource.refresh()}
          style={styles.retry}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    )
  }
  if (resource.reviews.length === 0) {
    return <StatePanel title="No review needed" detail="No applications need human review." />
  }
  return (
    <View>
      {resource.reviews.map((review) => (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: selectedId === review.review_id }}
          key={review.review_id}
          onPress={() => onSelect(selectedId === review.review_id ? null : review.review_id)}
          style={styles.reviewRow}
        >
          <View style={styles.reviewText}>
            <Text style={styles.reviewTitle}>{review.title}</Text>
            <Text numberOfLines={2} style={styles.reviewSummary}>
              {review.summary}
            </Text>
          </View>
          <Text style={styles.badge}>{STATE_LABELS[review.state]}</Text>
        </Pressable>
      ))}
    </View>
  )
}

function StatePanel({ title, detail }: { title: string; detail: string }) {
  return (
    <View style={styles.statePanel}>
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.muted}>{detail}</Text>
    </View>
  )
}

function ReviewDetail({
  review,
  resource,
  snapshot,
  onOpenExactTab
}: Props & { review: MaestroHumanReview }) {
  const [resolutions, setResolutions] = useState<Record<string, string>>({})
  const [submissionReference, setSubmissionReference] = useState('')
  const [rejectionReason, setRejectionReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const decisionsResolved = review.decisions.every((decision) =>
    resolutions[decision.decision_id]?.trim()
  )

  const run = async (request: MobileMaestroHumanReviewTransitionInput) => {
    setPending(true)
    setError(null)
    try {
      await resource.transition(request)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Review action failed.')
    } finally {
      setPending(false)
    }
  }

  return (
    <View style={styles.detail} testID="mobile-maestro-human-review-detail">
      <View style={styles.detailTitleRow}>
        <Text style={styles.detailTitle}>{review.title}</Text>
        <Text style={styles.badge}>{STATE_LABELS[review.state]}</Text>
      </View>
      <Text style={styles.muted}>{review.summary}</Text>
      <ReviewReferences review={review} />
      {(review.state === 'staged' || review.state === 'needs_input') &&
      review.decisions.length > 0 ? (
        <View style={styles.group}>
          <Text style={styles.groupTitle}>Decisions required</Text>
          {review.decisions.map((decision) => (
            <View key={decision.decision_id} style={styles.group}>
              <Text style={styles.referenceTitle}>{decision.prompt}</Text>
              <TextInput
                accessibilityLabel={decision.prompt}
                multiline
                onChangeText={(value) =>
                  setResolutions((current) => ({ ...current, [decision.decision_id]: value }))
                }
                placeholder="Record the human decision…"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                value={resolutions[decision.decision_id] ?? ''}
              />
            </View>
          ))}
        </View>
      ) : null}
      {review.state === 'approved_for_submit' ? (
        <TextInput
          accessibilityLabel="Submission receipt reference"
          onChangeText={setSubmissionReference}
          placeholder="Submission receipt reference…"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          value={submissionReference}
        />
      ) : null}
      {['staged', 'needs_input', 'approved_for_submit'].includes(review.state) ? (
        <TextInput
          accessibilityLabel="Rejection reason"
          multiline
          onChangeText={setRejectionReason}
          placeholder="Rejection reason…"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          value={rejectionReason}
        />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.actionError}>
          {error}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {resource.canFocusBrowser(review, snapshot) ? (
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() =>
              void resource
                .focusBrowser(review, snapshot)
                .then(onOpenExactTab, (cause) =>
                  setError(cause instanceof Error ? cause.message : 'Browser Focus failed.')
                )
            }
            style={[styles.action, pending && styles.disabled]}
          >
            <Text style={styles.actionText}>Browser Focus</Text>
          </Pressable>
        ) : null}
        <PrimaryAction
          review={review}
          disabled={pending || !decisionsResolved}
          resolutions={resolutions}
          submissionReference={submissionReference}
          run={run}
        />
        {['staged', 'needs_input', 'approved_for_submit'].includes(review.state) ? (
          <Pressable
            accessibilityRole="button"
            disabled={pending || !rejectionReason.trim()}
            onPress={() =>
              void run({
                request_id: receiptId('reject-request'),
                review_id: review.review_id,
                action: 'reject',
                receipt_id: receiptId('reject'),
                reason: rejectionReason.trim()
              })
            }
            style={[styles.action, (!rejectionReason.trim() || pending) && styles.disabled]}
          >
            <Text style={styles.actionText}>Reject</Text>
          </Pressable>
        ) : null}
      </View>
      <ReceiptSummary review={review} />
      <Pressable
        accessibilityRole="button"
        onPress={() => setTechnicalOpen((open) => !open)}
        style={styles.technicalButton}
      >
        <Text style={styles.technicalLabel}>
          {technicalOpen ? 'Hide' : 'Show'} technical details
        </Text>
      </Pressable>
      {technicalOpen ? <TechnicalDetails review={review} /> : null}
    </View>
  )
}

function ReviewReferences({ review }: { review: MaestroHumanReview }) {
  const references = [
    ...review.references.documents.map((item) => ({
      title: item.title,
      meta: `Revision ${item.revision}`
    })),
    ...review.references.fields.map((item) => ({ title: item.label, meta: item.field_path }))
  ]
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>Review scope</Text>
      {references.map((reference) => (
        <View key={`${reference.title}:${reference.meta}`} style={styles.referenceRow}>
          <Text style={styles.referenceTitle}>{reference.title}</Text>
          <Text style={styles.referenceMeta}>{reference.meta}</Text>
        </View>
      ))}
      {review.references.browser ? (
        <Text style={styles.muted}>Exact retained Browser surface attached</Text>
      ) : null}
    </View>
  )
}

function PrimaryAction({
  review,
  disabled,
  resolutions,
  submissionReference,
  run
}: {
  review: MaestroHumanReview
  disabled: boolean
  resolutions: Record<string, string>
  submissionReference: string
  run: (request: MobileMaestroHumanReviewTransitionInput) => Promise<void>
}) {
  if (review.state === 'staged' || review.state === 'needs_input') {
    return (
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={() =>
          void run({
            request_id: receiptId('approve-request'),
            review_id: review.review_id,
            action: 'approve',
            receipt_id: receiptId('approve'),
            decision_resolutions: review.decisions.map((decision) => ({
              decision_id: decision.decision_id,
              resolution: resolutions[decision.decision_id]!.trim()
            })),
            expires_at: new Date(Date.now() + APPROVAL_LIFETIME_MS).toISOString()
          })
        }
        style={[styles.action, styles.primaryAction, disabled && styles.disabled]}
      >
        <Text style={styles.primaryActionText}>Approve for submit</Text>
      </Pressable>
    )
  }
  if (review.state !== 'approved_for_submit') {
    return null
  }
  const submitDisabled = disabled || !submissionReference.trim()
  return (
    <Pressable
      accessibilityRole="button"
      disabled={submitDisabled}
      onPress={() =>
        void run({
          request_id: receiptId('submit-request'),
          review_id: review.review_id,
          action: 'submit',
          receipt_id: receiptId('submit'),
          submission_reference: submissionReference.trim()
        })
      }
      style={[styles.action, styles.primaryAction, submitDisabled && styles.disabled]}
    >
      <Text style={styles.primaryActionText}>Record submission</Text>
    </Pressable>
  )
}

function ReceiptSummary({ review }: { review: MaestroHumanReview }) {
  const lines = [
    review.approval_receipt
      ? `Approved until ${new Date(review.approval_receipt.expires_at).toLocaleString()}`
      : null,
    review.submission_receipt
      ? `Submitted: ${review.submission_receipt.submission_reference}`
      : null,
    review.rejection_receipt ? `Rejected: ${review.rejection_receipt.reason}` : null,
    review.expiration_receipt
      ? `Expired ${new Date(review.expiration_receipt.expired_at).toLocaleString()}`
      : null
  ].filter((line): line is string => Boolean(line))
  return lines.length ? (
    <View style={styles.receipt}>
      <Text style={styles.receiptTitle}>Receipts</Text>
      {lines.map((line) => (
        <Text key={line} style={styles.receiptText}>
          {line}
        </Text>
      ))}
    </View>
  ) : null
}

function TechnicalDetails({ review }: { review: MaestroHumanReview }) {
  const values = [review.review_id, review.task_id, review.dispatch_id]
  return (
    <View style={styles.group}>
      {values.map((value) => (
        <Text key={value} style={styles.technicalValue}>
          {value}
        </Text>
      ))}
    </View>
  )
}
