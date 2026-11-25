// Where a server is on: every workspace (with ones added later), or only the ones ticked. The same
// choice Repository settings' switches edit on the desktop.
import { useRef, useState } from 'react'
import { Folder } from '../components/icons/app-icons'
import { LIST_LEADING_INSET, ListRow } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsSection } from '../settings/settings-screen-frame'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { PhoneMcpServer, PhoneMcpWorkspaces } from './mcp-server-operations'
import {
  ALL_MCP_WORKSPACES,
  isAllMcpWorkspaces,
  isMcpWorkspaceOn,
  mcpServerTitle,
  toggleMcpWorkspace
} from './mcp-server-words'
import type { McpWorkspace } from './use-mcp-servers-data'
import { McpPageFrame } from './McpPageFrame'

export function MobileMcpWorkspacesPage(props: {
  server: PhoneMcpServer
  workspaces: readonly McpWorkspace[]
  online: boolean
  onBack: () => void
  /** Settles once the host has the choice; writes made meanwhile follow it in order. */
  onChange: (workspaces: PhoneMcpWorkspaces) => Promise<void>
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  // Taps build on the last one, not on the host's answer still on its way.
  const [draft, setDraft] = useState<PhoneMcpWorkspaces | null>(null)
  const writes = useRef(0)
  const chosen = draft ?? props.server.workspaces
  const choose = (next: PhoneMcpWorkspaces) => {
    setDraft(next)
    const write = (writes.current += 1)
    void props.onChange(next).finally(() => write === writes.current && setDraft(null))
  }
  const all = isAllMcpWorkspaces(chosen)
  return (
    <McpPageFrame
      title={t('mcpServers.workspaces', 'Workspaces')}
      subtitle={mcpServerTitle(props.server)}
      onBack={props.onBack}
    >
      <SettingsSection first>
        <ListRow
          title={t('mcpServers.allWorkspaces', 'All workspaces')}
          subtitle={t('mcpServers.includingLater', 'Including ones added later')}
          selected={all}
          accessibilityRole="radio"
          disabled={!props.online}
          onPress={() => choose(ALL_MCP_WORKSPACES)}
        />
      </SettingsSection>
      {props.workspaces.length > 0 ? (
        <SettingsSection
          separatorInset={LIST_LEADING_INSET}
          footer={t('mcpServers.appliesToNewNote', 'Changes apply to new sessions.')}
        >
          {props.workspaces.map((workspace) => {
            const on = !all && isMcpWorkspaceOn(chosen, workspace.key)
            return (
              <ListRow
                key={workspace.key}
                title={workspace.name}
                leading={<Folder size={18} color={colors.textSecondary} />}
                selected={on}
                accessibilityRole="checkbox"
                disabled={!props.online}
                onPress={() => choose(toggleMcpWorkspace(chosen, workspace.key))}
              />
            )
          })}
        </SettingsSection>
      ) : null}
    </McpPageFrame>
  )
}
