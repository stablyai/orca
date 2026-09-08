import { useMemo, useRef, useState } from './mobile-tasks-dependencies'
import {
  type DetailPayload,
  type GitHubAssignableUser,
  type GitHubPRFileContents,
  groupDetailComments
} from './mobile-tasks-model'

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
    copiedLinkKey,
    copiedLinkResetTimerRef,
    detailCommentGroups,
    detailError,
    detailLoading,
    detailPayload,
    detailRefreshSeq,
    expandedPrFilePath,
    expandedResolvedCommentGroups,
    itemAddAssigneesDraft,
    itemAddLabelsDraft,
    itemAssignableUsers,
    itemAssignableUsersError,
    itemAssignableUsersLoading,
    itemAvailableLabels,
    itemBodyDraft,
    itemCommentDraft,
    itemLabelsError,
    itemLabelsLoading,
    itemRemoveAssigneesDraft,
    itemRemoveLabelsDraft,
    itemReplyDrafts,
    itemReviewersDraft,
    itemTitleDraft,
    prFileCommentDrafts,
    prFileContents,
    prFileLoadingPath,
    setCopiedLinkKey,
    setDetailError,
    setDetailLoading,
    setDetailPayload,
    setDetailRefreshSeq,
    setExpandedPrFilePath,
    setExpandedResolvedCommentGroups,
    setItemAddAssigneesDraft,
    setItemAddLabelsDraft,
    setItemAssignableUsers,
    setItemAssignableUsersError,
    setItemAssignableUsersLoading,
    setItemAvailableLabels,
    setItemBodyDraft,
    setItemCommentDraft,
    setItemLabelsError,
    setItemLabelsLoading,
    setItemRemoveAssigneesDraft,
    setItemRemoveLabelsDraft,
    setItemReplyDrafts,
    setItemReviewersDraft,
    setItemTitleDraft,
    setPrFileCommentDrafts,
    setPrFileContents,
    setPrFileLoadingPath
  }
}
