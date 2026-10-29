import {
  type GitHubAssignableUser,
  type GitHubPRFileContents,
  type DetailPayload,
  groupDetailComments
} from './mobile-tasks-legacy-foundation'
import { useMemo, useRef, useState } from './mobile-tasks-dependencies'

export function useMobileTasksItemState() {
  const [detailPayload, setDetailPayload] = useState<DetailPayload | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailRefreshSeq, setDetailRefreshSeq] = useState(0)
  const [itemTitleDraft, setItemTitleDraft] = useState('')
  const [itemBodyDraft, setItemBodyDraft] = useState('')
  const [itemCommentDraft, setItemCommentDraft] = useState('')
  const [itemAddLabelsDraft, setItemAddLabelsDraft] = useState('')
  const [itemRemoveLabelsDraft, setItemRemoveLabelsDraft] = useState('')
  const [itemAddAssigneesDraft, setItemAddAssigneesDraft] = useState('')
  const [itemRemoveAssigneesDraft, setItemRemoveAssigneesDraft] = useState('')
  const [itemAvailableLabels, setItemAvailableLabels] = useState<string[]>([])
  const [itemLabelsLoading, setItemLabelsLoading] = useState(false)
  const [itemLabelsError, setItemLabelsError] = useState('')
  const [itemAssignableUsers, setItemAssignableUsers] = useState<GitHubAssignableUser[]>([])
  const [itemAssignableUsersLoading, setItemAssignableUsersLoading] = useState(false)
  const [itemAssignableUsersError, setItemAssignableUsersError] = useState('')
  const [itemReviewersDraft, setItemReviewersDraft] = useState('')
  const [itemReplyDrafts, setItemReplyDrafts] = useState<Record<string, string>>({})
  const [expandedPrFilePath, setExpandedPrFilePath] = useState<string | null>(null)
  const [prFileContents, setPrFileContents] = useState<Record<string, GitHubPRFileContents>>({})
  const [prFileLoadingPath, setPrFileLoadingPath] = useState<string | null>(null)
  const [prFileCommentDrafts, setPrFileCommentDrafts] = useState<Record<string, string>>({})
  const [copiedLinkKey, setCopiedLinkKey] = useState<string | null>(null)
  const copiedLinkResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [expandedResolvedCommentGroups, setExpandedResolvedCommentGroups] = useState<Set<string>>(
    () => new Set()
  )
  const detailCommentGroups = useMemo(
    () => groupDetailComments(detailPayload?.comments ?? []),
    [detailPayload?.comments]
  )
  return {
    detailPayload,
    setDetailPayload,
    detailLoading,
    setDetailLoading,
    detailError,
    setDetailError,
    detailRefreshSeq,
    setDetailRefreshSeq,
    itemTitleDraft,
    setItemTitleDraft,
    itemBodyDraft,
    setItemBodyDraft,
    itemCommentDraft,
    setItemCommentDraft,
    itemAddLabelsDraft,
    setItemAddLabelsDraft,
    itemRemoveLabelsDraft,
    setItemRemoveLabelsDraft,
    itemAddAssigneesDraft,
    setItemAddAssigneesDraft,
    itemRemoveAssigneesDraft,
    setItemRemoveAssigneesDraft,
    itemAvailableLabels,
    setItemAvailableLabels,
    itemLabelsLoading,
    setItemLabelsLoading,
    itemLabelsError,
    setItemLabelsError,
    itemAssignableUsers,
    setItemAssignableUsers,
    itemAssignableUsersLoading,
    setItemAssignableUsersLoading,
    itemAssignableUsersError,
    setItemAssignableUsersError,
    itemReviewersDraft,
    setItemReviewersDraft,
    itemReplyDrafts,
    setItemReplyDrafts,
    expandedPrFilePath,
    setExpandedPrFilePath,
    prFileContents,
    setPrFileContents,
    prFileLoadingPath,
    setPrFileLoadingPath,
    prFileCommentDrafts,
    setPrFileCommentDrafts,
    copiedLinkKey,
    setCopiedLinkKey,
    copiedLinkResetTimerRef,
    expandedResolvedCommentGroups,
    setExpandedResolvedCommentGroups,
    detailCommentGroups
  }
}
