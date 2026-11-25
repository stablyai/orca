// Host ⋯ › MCP servers: the host's own list, a server's page pushed over it, its Workspaces pushed
// over that, and Add and Sign in as sheets. Shown only when the host lists mcp-servers.v1, which it
// does only while its MCP servers switch is on.
import { useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams } from 'expo-router'
import { Server } from 'lucide-react-native'
import { MCP_SERVERS_RUNTIME_CAPABILITY } from '../../../src/shared/mcp-servers/mcp-servers'
import { BottomDrawer, OptionPager, useOptionPager } from '../components/bottom-drawer/BottomDrawer'
import { BottomDrawerModalHost } from '../components/bottom-drawer/bottom-drawer-modal-host'
import { MobileLoadErrorState, MobileStateView } from '../components/feedback/MobileStateView'
import { TransientToast, useTransientToast } from '../components/feedback/TransientToast'
import { useHostProtocolGates } from '../components/host-connection/host-protocol-gates-context'
import { SheetPageScroll } from '../components/nav-bar/sheet-page-scroll'
import { ConfirmModal } from '../components/sheets/ConfirmModal'
import { loadHosts, peekHosts } from '../host-catalog/host-store'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { useRouteHandoff } from '../navigation/route-handoff'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useHostClient } from '../transport/connection/host-client-hooks'
import { useRouteCapability } from '../worktree/execution-hosts/use-route-capability'
import { McpPageFrame } from './McpPageFrame'
import { MobileMcpAddSheet } from './MobileMcpAddSheet'
import { MobileMcpServerList } from './MobileMcpServerList'
import { MobileMcpServerPage } from './MobileMcpServerPage'
import { MobileMcpSignInSheet } from './MobileMcpSignInSheet'
import { MobileMcpWorkspacesPage } from './MobileMcpWorkspacesPage'
import type { PhoneMcpServer } from './mcp-server-operations'
import { useMcpServerActions } from './use-mcp-server-actions'
import { useMcpServersData } from './use-mcp-servers-data'

function useHostName(hostId: string): string {
  const [name, setName] = useState(
    () => peekHosts()?.find((host) => host.id === hostId)?.name ?? ''
  )
  useEffect(() => {
    let live = true
    void loadHosts().then((hosts) => {
      const host = hosts.find((entry) => entry.id === hostId)
      if (live && host) {
        setName(host.name)
      }
    })
    return () => {
      live = false
    }
  }, [hostId])
  return name
}

export function MobileMcpServersScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const { hostId = '' } = useLocalSearchParams<{ hostId: string }>()
  const { client, state } = useHostClient(hostId)
  const online = state === 'connected'
  const hostName = useHostName(hostId)
  const { statusPending } = useHostProtocolGates()
  const capable = useRouteCapability(MCP_SERVERS_RUNTIME_CAPABILITY)
  const data = useMcpServersData(hostId, client, capable)
  const { message, action, showToast, showActionToast } = useTransientToast()
  const actions = useMcpServerActions({
    client,
    list: data.list,
    applyServer: data.applyServer,
    showToast: showActionToast,
    t
  })
  const pager = useOptionPager<'server'>()
  const workspacesPager = useOptionPager<'workspaces'>()
  const [openedId, setOpenedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [signingIn, setSigningIn] = useState<PhoneMcpServer | null>(null)
  const servers = data.list?.servers ?? []
  const found = servers.find((server) => server.id === openedId) ?? null
  // A removed server's page keeps its last read while it slides away.
  const [lastOpened, setLastOpened] = useState<PhoneMcpServer | null>(null)
  if (found && found !== lastOpened) {
    setLastOpened(found)
  }
  const opened = openedId === null ? null : (found ?? lastOpened)
  const workspaceNames = useMemo(
    () => new Map(data.workspaces.map((workspace) => [workspace.key, workspace.name])),
    [data.workspaces]
  )
  // A server removed here or elsewhere takes its page with it.
  const gone = openedId !== null && data.list !== null && found === null
  const { close: closeServer } = pager
  const { forget: forgetWorkspaces } = workspacesPager
  useEffect(() => {
    if (gone) {
      forgetWorkspaces()
      closeServer()
    }
  }, [gone, closeServer, forgetWorkspaces])
  // A sheet opens only once the one before it has gone: iOS refuses a second presentation mid-close.
  const signInAfterAdd = useRef<PhoneMcpServer | null>(null)

  const open = (server: PhoneMcpServer) => {
    setOpenedId(server.id)
    pager.open('server')
  }
  useBackClaim(() => {
    if (workspacesPager.page) {
      workspacesPager.close()
    } else if (pager.page) {
      pager.close()
    } else {
      return false
    }
    return true
  })

  const list = (
    <McpPageFrame
      title={t('mcpServers.title', 'MCP servers')}
      subtitle={hostName}
      onBack={() => router.back()}
      fill={!capable || data.list === null}
    >
      {!capable ? (
        <MobileStateView
          icon={Server}
          loading={statusPending}
          title={
            statusPending
              ? t('mcpServers.reading', 'Reading MCP servers…')
              : t('mcpServers.unavailable', 'MCP servers aren’t on {{host}}', { host: hostName })
          }
        />
      ) : data.list ? (
        <MobileMcpServerList
          servers={servers}
          discovered={data.discovered}
          problems={data.problems}
          agents={data.agents}
          workspaceNames={workspaceNames}
          online={online}
          onOpen={open}
          onSignIn={setSigningIn}
          onAdd={() => setAdding(true)}
          onMove={actions.move}
          onCopy={actions.copy}
        />
      ) : data.listError ? (
        <MobileLoadErrorState error={data.listError} onRetry={data.reread} />
      ) : (
        <MobileStateView loading title={t('mcpServers.reading', 'Reading MCP servers…')} />
      )}
    </McpPageFrame>
  )

  const serverPage =
    opened && data.list ? (
      <OptionPager
        pager={workspacesPager}
        fill
        main={
          <MobileMcpServerPage
            client={client}
            server={opened}
            list={data.list}
            agents={data.agents}
            agentsFailed={data.agentsFailed}
            workspaceNames={workspaceNames}
            online={online}
            actions={actions}
            onBack={pager.close}
            onWorkspaces={() => workspacesPager.open('workspaces')}
            onSignIn={() => setSigningIn(opened)}
          />
        }
        page={
          workspacesPager.page ? (
            <MobileMcpWorkspacesPage
              server={opened}
              workspaces={data.workspaces}
              online={online}
              onBack={workspacesPager.close}
              onChange={(workspaces) => actions.setWorkspaces(opened, workspaces)}
            />
          ) : null
        }
      />
    ) : null

  return (
    <BottomDrawerModalHost>
      <View style={styles.page}>
        <OptionPager pager={pager} fill main={list} page={pager.page ? serverPage : null} />
        <TransientToast message={message} action={action} bottomInset={insets.bottom} />
      </View>
      <BottomDrawer
        visible={adding}
        onClose={() => setAdding(false)}
        onAfterClose={() => {
          setSigningIn(signInAfterAdd.current)
          signInAfterAdd.current = null
        }}
        fillAvailable
        contentScrollable={false}
        dragContentToDismiss={false}
      >
        <View style={styles.sheet}>
          <SheetPageScroll style={styles.sheet}>
            <MobileMcpAddSheet
              client={client}
              hostName={hostName}
              servers={servers}
              online={online}
              onClose={() => setAdding(false)}
              onOpen={(server) => {
                setAdding(false)
                data.applyServer(server)
                open(server)
                if (server.signIn && server.signIn.state !== 'signed-in') {
                  signInAfterAdd.current = server
                }
              }}
            />
          </SheetPageScroll>
        </View>
      </BottomDrawer>
      <MobileMcpSignInSheet
        client={client}
        server={signingIn}
        hostName={hostName}
        online={online}
        onClose={() => setSigningIn(null)}
        onSignedIn={(server) => {
          setSigningIn(null)
          data.reread()
          showToast(t('mcpServers.signedInTo', 'Signed in to {{app}}', { app: server }))
        }}
      />
      <ConfirmModal
        visible={actions.confirm !== null}
        title={actions.confirm?.title ?? ''}
        message={actions.confirm?.message}
        confirmLabel={actions.confirm?.confirmLabel}
        destructive={actions.confirm?.destructive}
        onCancel={actions.closeConfirm}
        onConfirm={() => {
          const confirmed = actions.confirm
          actions.closeConfirm()
          confirmed?.onConfirm()
        }}
      />
    </BottomDrawerModalHost>
  )
}

const styles = themedStyleSheet(() => ({
  page: { flex: 1, backgroundColor: colors.sheetSurface },
  sheet: { flex: 1 }
}))
