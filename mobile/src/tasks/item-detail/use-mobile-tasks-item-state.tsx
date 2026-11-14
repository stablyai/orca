import type {
  GitHubAssignableUser,
  GitHubPRFileContents,
  DetailPayload
} from '../mobile-tasks-provider-detail-types'
import { groupDetailComments } from './mobile-tasks-item-comments'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { SetStateAction } from 'react'

export function useMobileTasksItemState() {
  const acceptedDetail = useRef<DetailPayload | null>(null)
  const [detailPayload, publishDetailPayload] = useState<DetailPayload | null>(null)
  const setDetailPayload = useCallback((update: SetStateAction<DetailPayload | null>) => {
    const next = typeof update === 'function' ? update(acceptedDetail.current) : update
    acceptedDetail.current = next
    publishDetailPayload(next)
  }, [])
  const readDetailPayload = useCallback(() => acceptedDetail.current, [])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailRefreshSeq, setDetailRefreshSeq] = useState(0)
  // Set only by the user's explicit Refresh and consumed by the load it starts; other reloads read ordinarily.
  const detailRefreshRequested = useRef(false)
  const requestDetailRefresh = useCallback(() => {
    detailRefreshRequested.current = true
    setDetailRefreshSeq((current) => current + 1)
  }, [])
  const [itemTitleDraft, setItemTitleDraft] = useState('')
  const [itemBodyDraft, setItemBodyDraft] = useState('')
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
  const fileRequest = useRef<{ reload: () => void } | null>(null)
  const interruptedFileRequest = useRef<{ reload: () => void } | null>(null)
  const resetPrFiles = useCallback(() => {
    fileRequest.current = null
    interruptedFileRequest.current = null
    setPrFileContents({})
    setPrFileLoadingPath(null)
    setExpandedPrFilePath(null)
  }, [])
  // Every connection change retires the open file read but keeps accepted contents and expansion; once connected it reads again.
  const reconcilePrFileConnection = useCallback((connected: boolean) => {
    if (fileRequest.current) {
      interruptedFileRequest.current = fileRequest.current
      fileRequest.current = null
      setPrFileLoadingPath(null)
    }
    if (!connected) {
      return
    }
    const interrupted = interruptedFileRequest.current
    interruptedFileRequest.current = null
    interrupted?.reload()
  }, [])
  const beginFileLoad = useCallback(
    (path: string, canObserve: () => boolean, reload: () => void) => {
      const request = { reload }
      fileRequest.current = request
      interruptedFileRequest.current = null
      setPrFileLoadingPath(path)
      return {
        canPublish: () => fileRequest.current === request && canObserve(),
        finish: () => {
          if (fileRequest.current === request) {
            fileRequest.current = null
            setPrFileLoadingPath(null)
          }
        }
      }
    },
    []
  )
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
    readDetailPayload,
    detailLoading,
    setDetailLoading,
    detailError,
    setDetailError,
    detailRefreshSeq,
    setDetailRefreshSeq,
    detailRefreshRequested,
    requestDetailRefresh,
    itemTitleDraft,
    setItemTitleDraft,
    itemBodyDraft,
    setItemBodyDraft,
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
    beginFileLoad,
    resetPrFiles,
    reconcilePrFileConnection,
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
