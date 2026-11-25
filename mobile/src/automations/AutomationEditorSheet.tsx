// The editor sheet over the Automations page: the agents' editor for an agent's automation, the
// automation editor for any other, and the pickers and confirms both open, in one modal host.
import type { ReactNode } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { BottomDrawerModalHost } from '../components/bottom-drawer/bottom-drawer-modal-host'
import { describeLoadError } from '../components/feedback/load-error-description'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { MobileAutomationRow } from './automation-reply-schema'
import type { AutomationDraft } from './automation-draft'
import type { AutomationTargets } from './automation-target-inventory'
import { automationEditorDraftKey } from './automation-editor-draft-row'
import { AutomationEditor, type AutomationEditorSection } from './AutomationEditor'
import type { AutomationLeaveSlot } from './AutomationEditorNavigation'
import { AutomationPageBotEditor } from './AutomationPageBotEditor'
import { useAutomationSheet } from './AutomationSheets'

/** A new automation, or one automation (all of it, or one section); `key` is each opening's own. */
export type AutomationEditorRequest = {
  key: number
  row?: MobileAutomationRow
  initialDraft?: AutomationDraft
  section?: AutomationEditorSection
}

export function AutomationEditorSheet(props: {
  /** Kept while the sheet slides away, so it leaves with what it showed. */
  request: AutomationEditorRequest | null
  open: boolean
  client: RpcClient | null
  hostId: string
  executionHost?: ExecutionHostId
  catalog: {
    connected: boolean
    busy: boolean
    loaded: boolean
    capabilities: readonly string[]
    error: string | null
  }
  leaveGuard?: AutomationLeaveSlot
  onDraftChange: (draft: AutomationDraft) => void
  onClose: () => void
  /** The sheet for request `key` finished closing; a newer request stays. */
  onAfterClose: (key: number) => void
  onSave: (draft: AutomationDraft, original: AutomationDraft, targets: AutomationTargets) => void
  onBotSaved: (row: MobileAutomationRow) => void
  /** Drawers a save may raise over the editor, e.g. the setup trust prompt. */
  children?: ReactNode
}) {
  const t = useMobileTranslation()
  const { present, host: sheets } = useAutomationSheet()
  const { request, catalog } = props
  return (
    <BottomDrawerModalHost>
      {request?.row?.automation.bot ? (
        <AutomationPageBotEditor
          key={request.key}
          visible={props.open}
          row={request.row}
          client={props.client}
          hostId={props.hostId}
          executionHost={props.executionHost}
          connected={catalog.connected}
          present={present}
          leaveGuard={props.leaveGuard}
          onClose={props.onClose}
          onAfterClose={() => props.onAfterClose(request.key)}
          onSaved={props.onBotSaved}
        />
      ) : request && props.client && catalog.loaded ? (
        <AutomationEditor
          key={request.key}
          visible={props.open}
          client={props.client}
          current={request.row?.automation}
          section={request.section}
          initialDraft={request.initialDraft}
          draftKey={automationEditorDraftKey(props.executionHost, request.row?.automation.id)}
          onDraftChange={props.onDraftChange}
          leaveGuard={props.leaveGuard}
          capabilities={catalog.capabilities}
          busy={catalog.busy}
          saveError={catalog.error && describeLoadError(catalog.error, t).message}
          connected={catalog.connected}
          present={present}
          onClose={props.onClose}
          onAfterClose={() => props.onAfterClose(request.key)}
          onSave={props.onSave}
        />
      ) : null}
      {sheets}
      {props.children}
    </BottomDrawerModalHost>
  )
}
