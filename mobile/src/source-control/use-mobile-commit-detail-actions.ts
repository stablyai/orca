import { useCallback, useRef, useState } from 'react'
import { buildCommitExplainPrompt } from '../../../src/shared/commit-explain-prompt'
import { translate } from '../i18n/mobile-i18n'
import { useClipboardWriter } from '../platform/clipboard'
import { openExternalLink } from '../platform/external-link'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { launchAgentWithPrompt, promptedLaunchNotice } from '../session/pr-ai-triage-launch'
import { gitRemoteCommitUrlRead } from './mobile-git-read-operations'
import type { MobileCommitDetail } from './use-mobile-commit-detail'

function waitingForDesktop(): string {
  return translate('sourceControl.commitDetail.waitingForDesktop', 'Waiting for desktop...')
}

export type MobileCommitDetailNotice = { tone: 'success' | 'error'; text: string } | null
export type MobileCommitExplainLaunch = ReturnType<typeof promptedLaunchNotice>

function launchFailure(error: string): MobileCommitExplainLaunch {
  return { succeeded: false, success: null, error, warning: null, undeliveredPrompt: null }
}

// Desktop's commit context-menu actions: copy, open on the web remote, explain with the default agent.
export function useMobileCommitDetailActions(input: {
  client: RpcClient | null
  connState: ConnectionState
  hostCapabilities: readonly string[]
  worktreeId: string
  workspaceLabel: string
  commitId: string
  detail: MobileCommitDetail | null
}) {
  const { client, connState, hostCapabilities, worktreeId, workspaceLabel, commitId, detail } =
    input
  const clipboard = useClipboardWriter()
  const [notice, setNotice] = useState<MobileCommitDetailNotice>(null)
  const [launch, setLaunch] = useState<MobileCommitExplainLaunch | null>(null)
  const [explaining, setExplaining] = useState(false)
  // Lock synchronously: async busy state cannot stop a same-frame double tap from launching twice.
  const explainingRef = useRef(false)

  const fail = useCallback((text: string) => {
    triggerError()
    setNotice({ tone: 'error', text })
  }, [])

  const copy = useCallback(
    async (value: string, copied: string) => {
      try {
        await clipboard.writeText(value)
        triggerSuccess()
        setNotice({ tone: 'success', text: copied })
      } catch {
        fail(translate('sourceControl.commitDetail.copyFailed', 'Could not copy'))
      }
    },
    [clipboard, fail]
  )

  const connected = client !== null && connState === 'connected'

  const openRemote = useCallback(async () => {
    if (!commitId) {
      return
    }
    if (!client || !connected) {
      fail(waitingForDesktop())
      return
    }
    try {
      const url = gitRemoteCommitUrlRead.interpret(
        await gitRemoteCommitUrlRead.request(client, {
          worktree: `id:${worktreeId}`,
          sha: commitId
        })
      )
      if (!url) {
        fail(
          translate(
            'sourceControl.commitDetail.noWebRemote',
            'This repository has no supported web remote'
          )
        )
        return
      }
      openExternalLink(url)
    } catch {
      fail(
        translate('sourceControl.commitDetail.openRemoteFailed', 'Failed to open commit in browser')
      )
    }
  }, [client, commitId, connected, fail, worktreeId])

  const explain = useCallback(async () => {
    if (explainingRef.current || !commitId) {
      return
    }
    setNotice(null)
    if (!client || !connected) {
      triggerError()
      setLaunch(launchFailure(waitingForDesktop()))
      return
    }
    explainingRef.current = true
    setExplaining(true)
    setLaunch(null)
    try {
      const result = await launchAgentWithPrompt({
        client,
        hostCapabilities,
        worktreeId,
        actionId: null,
        prompt: buildCommitExplainPrompt({
          id: commitId,
          displayId: detail?.shortId,
          subject: detail?.subject ?? ''
        }),
        launchSource: 'explain_commit'
      })
      const launched = promptedLaunchNotice(result, workspaceLabel)
      if (launched.succeeded) {
        triggerSuccess()
      } else {
        triggerError()
      }
      setLaunch(launched)
    } catch (err) {
      triggerError()
      setLaunch(
        launchFailure(
          err instanceof Error
            ? err.message
            : translate('sourceControl.commitDetail.explainFailed', 'Failed to launch agent')
        )
      )
    } finally {
      explainingRef.current = false
      setExplaining(false)
    }
  }, [client, commitId, connected, detail, hostCapabilities, workspaceLabel, worktreeId])

  return {
    notice,
    launch,
    explaining,
    copyMessage: () =>
      detail
        ? void copy(
            detail.message,
            translate('sourceControl.commitDetail.messageCopied', 'Commit message copied')
          )
        : undefined,
    copySha: () =>
      void copy(commitId, translate('sourceControl.commitDetail.shaCopied', 'Commit hash copied')),
    openRemote: () => void openRemote(),
    explain: () => void explain()
  }
}
