import { useMemo } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { MobileSourceControlRoute } from '../../../../app/h/[hostId]/source-control/[worktreeId]'
import { useMobileWebNativeShell } from '../../../../../src/mobile-web/src/native-shell-channel'
import { webHostSourceControlClient } from '../../../../src/source-control/web-host-source-control-client'

export default function HostMobileWebSourceControlRoute() {
  const params = useLocalSearchParams<{ worktreeId?: string | string[] }>()
  const workspaceId = firstParam(params.worktreeId)
  const shell = useMobileWebNativeShell()
  const workspaceName =
    shell.resumeRoute.kind === 'session' && shell.resumeRoute.workspaceId === workspaceId
      ? shell.resumeRoute.workspaceName
      : undefined
  const client = useMemo(
    () =>
      shell.client && workspaceId ? webHostSourceControlClient(shell.client, workspaceId) : null,
    [shell.client, workspaceId]
  )
  const connectionState =
    shell.connection === 'offline'
      ? 'disconnected'
      : shell.connection === 'recovering'
        ? 'reconnecting'
        : shell.connection

  return (
    <MobileSourceControlRoute
      routeName={workspaceName}
      binding={{
        client,
        connectionState,
        reconnect: async () => {
          await shell.client?.navigationReconnect()
        },
        openExternalUrl: async (url) => {
          await shell.client?.native.openExternal(url)
        },
        writeClipboard: async (text) => {
          await shell.client?.native.clipboardWrite(text)
        },
        feedback: {
          selection: () => {
            void shell.client?.native.hapticSelection().catch(() => {})
          },
          success: () => {
            void shell.client?.native.hapticFeedback('success').catch(() => {})
          },
          error: () => {
            void shell.client?.native.hapticFeedback('error').catch(() => {})
          }
        }
      }}
    />
  )
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}
