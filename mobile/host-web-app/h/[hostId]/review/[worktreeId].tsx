import { useMemo } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { MobileDiffReviewRoute } from '../../../../app/h/[hostId]/review/[worktreeId]'
import { useMobileWebNativeShell } from '../../../../../src/mobile-web/src/native-shell-channel'
import { webHostDiffReviewClient } from '../../../../src/session/web-host-diff-review-client'

export default function HostMobileWebDiffReviewRoute() {
  const params = useLocalSearchParams<{ worktreeId?: string | string[] }>()
  const workspaceId = firstParam(params.worktreeId)
  const shell = useMobileWebNativeShell()
  const workspaceName =
    shell.resumeRoute.kind === 'session' && shell.resumeRoute.workspaceId === workspaceId
      ? shell.resumeRoute.workspaceName
      : undefined
  const client = useMemo(
    () => (shell.client && workspaceId ? webHostDiffReviewClient(shell.client, workspaceId) : null),
    [shell.client, workspaceId]
  )
  const connectionState =
    shell.connection === 'offline'
      ? 'disconnected'
      : shell.connection === 'recovering'
        ? 'reconnecting'
        : shell.connection

  return (
    <MobileDiffReviewRoute
      routeName={workspaceName}
      binding={{
        client,
        connectionState,
        reconnect: async () => {
          await shell.client?.navigationReconnect()
        },
        device: {
          selection: () => {
            void shell.client?.native.hapticSelection().catch(() => {})
          },
          success: () => {
            void shell.client?.native.hapticFeedback('success').catch(() => {})
          },
          error: () => {
            void shell.client?.native.hapticFeedback('error').catch(() => {})
          },
          writeClipboard: async (text) => {
            await shell.client?.native.clipboardWrite(text)
          },
          openExternal: async (url) => {
            await shell.client?.native.openExternal(url)
          }
        }
      }}
    />
  )
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}
