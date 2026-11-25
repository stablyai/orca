import { useAutomationSetupConsent } from './use-automation-setup-consent'
import { OrcaHookTrustDrawer } from '../components/hook-trust/OrcaHookTrustDrawer'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useAutomationRuns, type AutomationRunScope } from './use-automation-runs'
import { useState, type ReactNode } from 'react'
import { useAutomationCreateAttempt } from './use-automation-create-attempt'
import { ScrollView } from 'react-native'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { toAutomationOwnerPrecondition } from '../../../src/shared/automations/ownership/automation-owner-precondition'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  AutomationCatalogNotes,
  AutomationNewButton,
  AutomationTabs,
  type AutomationHeaderBar
} from './AutomationControls'
import { AutomationList } from './AutomationList'
import { AutomationDetail, AutomationRunNowBar, automationDetailBar } from './AutomationDetail'
import type { AutomationEditorSection } from './AutomationEditor'
import { AutomationEditorSheet, type AutomationEditorRequest } from './AutomationEditorSheet'
import { leaveThrough, type AutomationLeaveSlot } from './AutomationEditorNavigation'
import {
  AutomationRecentRuns,
  AutomationRunsBar,
  AutomationRunsView,
  useAutomationRunFilters
} from './AutomationRunList'
import { useTransientToast } from '../components/feedback/TransientToast'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AutomationRunDetails, automationRunBar } from './AutomationRunDetails'
import type { MobileAutomationRow, MobileAutomationRun } from './automation-reply-schema'
import {
  automationDeleteWrite,
  automationRunWrite,
  automationShowRead,
  automationUpdateWrite
} from './automation-operations'
import { automationUpdateParams, type AutomationDraft } from './automation-draft'
import type { AutomationTargets } from './automation-target-inventory'
import { useAutomationCatalog, useStartOnAutomation } from './use-automation-catalog'
import { dropAutomationEditorDraft } from './automation-editor-draft-row'
import { automationStyles as styles } from './automation-styles'
import { useAutomationProjectNames } from './use-automation-project-names'

type AutomationView =
  | { kind: 'list' }
  | { kind: 'detail'; row: MobileAutomationRow }
  // Back returns to where it opened: the automation, or the Runs list.
  | { kind: 'run'; run: MobileAutomationRun; scope: AutomationRunScope; back: AutomationView }
const ACTION_OPTIONS = { failWhenDisconnected: true }
const ownedBy = (row: MobileAutomationRow) => ({
  id: row.automation.id,
  expectedOwner: toAutomationOwnerPrecondition(row.item.selector)
})

export function AutomationManager(props: {
  client: RpcClient | null
  hostId: string
  executionHost?: ExecutionHostId
  /** Opens on a new automation's editor, shown once the catalog loads; read on mount only. */
  startInEditor?: boolean
  /** Opens on this automation and its runs once the catalog lists it; read on mount only. */
  startOnAutomation?: string
  /** The screen's bar; it carries the Automations / Runs switch as its accessory. */
  renderHeader?: (tabs: ReactNode, bar: AutomationHeaderBar) => ReactNode
  /** Filled while the editor is open, so tab and host switches ask before dropping its edits. */
  leaveGuard?: AutomationLeaveSlot
}) {
  useMobileColorScheme()
  const catalog = useAutomationCatalog(props.hostId, props.client, props.executionHost)
  const [view, setView] = useState<AutomationView>({ kind: 'list' })
  // Kept while the sheet slides away, so it leaves with what it showed.
  const [editor, setEditor] = useState<AutomationEditorRequest | null>(
    props.startInEditor ? { key: 0 } : null
  )
  const [editorOpen, setEditorOpen] = useState(props.startInEditor === true)
  // A saved edit closes the sheet onto the automation it saved.
  function closeOn(saved: MobileAutomationRow) {
    setEditorOpen(false)
    setView({ kind: 'detail', row: saved })
  }
  function openEditor(request: Omit<AutomationEditorRequest, 'key'>) {
    // The sheet shows the page's last failure, so an older one shouldn't greet it.
    catalog.setError(null)
    setEditor((current) => ({ ...request, key: (current?.key ?? 0) + 1 }))
    setEditorOpen(true)
  }
  const [tab, setTab] = useState<'automations' | 'runs'>('automations')
  const runFilters = useAutomationRunFilters(catalog.rows)
  const toast = useTransientToast()
  const insets = useSafeAreaInsets()
  useStartOnAutomation(catalog, props.startOnAutomation, (row) => setView({ kind: 'detail', row }))
  const createAttempt = useAutomationCreateAttempt(
    catalog.rows,
    editorOpen && editor !== null && !editor.row,
    (saved, initialDraft) => {
      catalog.setError(null)
      setView({ kind: 'detail', row: saved })
      if (initialDraft) {
        openEditor({ row: saved, initialDraft })
      } else {
        setEditorOpen(false)
      }
    },
    catalog.isCurrentSnapshot,
    () => dropAutomationEditorDraft(props.executionHost)
  )
  const setupConsent = useAutomationSetupConsent(props.client, props.executionHost)
  const projectName = useAutomationProjectNames(
    props.hostId,
    props.client,
    props.executionHost === undefined
  )
  const disabled = !catalog.connected || catalog.busy
  const row =
    view.kind === 'detail'
      ? (catalog.rows.find((entry) => entry.automation.id === view.row.automation.id) ?? view.row)
      : null
  const historyScope =
    view.kind === 'run'
      ? view.scope
      : row
        ? {
            automationId: row.automation.id,
            expectedOwner: toAutomationOwnerPrecondition(row.item.selector)
          }
        : runFilters.scope
  const history = useAutomationRuns(
    props.client,
    historyScope,
    catalog.revision,
    catalog.connected,
    view.kind === 'run' ? view.run : undefined,
    view.kind === 'detail' || view.kind === 'run' || (view.kind === 'list' && tab === 'runs')
  )
  function showList(next: 'automations' | 'runs') {
    setTab(next)
    setView({ kind: 'list' })
  }
  const allAutomations = () => showList('automations')
  function allRuns(automationId = '') {
    runFilters.selectAutomation(automationId)
    showList('runs')
  }
  function toggle(selected: MobileAutomationRow, enabled: boolean) {
    void catalog.perform(
      async (client) =>
        automationUpdateWrite.interpret(
          await automationUpdateWrite.request(
            client,
            { ...ownedBy(selected), updates: { enabled } },
            ACTION_OPTIONS
          )
        ),
      ({ automation }) => {
        catalog.setRows((previous) =>
          previous.map((entry) =>
            entry.automation.id === automation.id ? { ...entry, automation } : entry
          )
        )
        if (view.kind === 'detail') {
          setView({ kind: 'detail', row: { ...selected, automation } })
        }
      }
    )
  }
  function edit(selected: MobileAutomationRow, section?: AutomationEditorSection) {
    void catalog.perform(
      async (client) =>
        automationShowRead.interpret(
          await automationShowRead.request(client, ownedBy(selected), ACTION_OPTIONS)
        ),
      ({ automation }) =>
        openEditor({
          row: { ...selected, automation },
          ...(automation.bot ? {} : { section })
        })
    )
  }
  async function runNow(selected: MobileAutomationRow): Promise<boolean> {
    let accepted = false
    await catalog.perform(
      async (client) =>
        automationRunWrite.interpret(
          await automationRunWrite.request(client, ownedBy(selected), ACTION_OPTIONS)
        ),
      ({ run }) => {
        accepted = true
        setView({
          kind: 'run',
          run,
          scope: {
            automationId: selected.automation.id,
            expectedOwner: toAutomationOwnerPrecondition(selected.item.selector)
          },
          back: { kind: 'detail', row: selected }
        })
      }
    )
    return accepted
  }
  function remove(selected: MobileAutomationRow) {
    void catalog.perform(
      async (client) =>
        automationDeleteWrite.interpret(
          await automationDeleteWrite.request(client, ownedBy(selected), ACTION_OPTIONS)
        ),
      () => {
        catalog.setRows((previous) =>
          previous.filter((entry) => entry.automation.id !== selected.automation.id)
        )
        allAutomations()
      }
    )
  }
  function save(draft: AutomationDraft, original: AutomationDraft, targets: AutomationTargets) {
    const editing = editor?.row
    void catalog.perform(
      async (client, current) => {
        if (editing) {
          const prepared = await setupConsent.prepare(client, draft, targets, current, original)
          if (!prepared || !current()) {
            return null
          }
          const params = automationUpdateParams(editing.automation.id, prepared, original, targets)
          const result = automationUpdateWrite.interpret(
            await automationUpdateWrite.request(
              client,
              {
                ...params,
                expectedOwner: toAutomationOwnerPrecondition(editing.item.selector)
              },
              ACTION_OPTIONS
            )
          )
          return {
            automation: result.automation,
            item: params.destination
              ? { automationId: result.automation.id, selector: params.destination.selector }
              : editing.item
          }
        }
        await createAttempt.submit(client, draft, targets, catalog.capabilities, current, () =>
          setupConsent.prepare(client, draft, targets, current)
        )
        return null
      },
      (saved) => {
        if (!saved) {
          return
        }
        const id = saved.automation.id
        dropAutomationEditorDraft(props.executionHost, id)
        catalog.setRows((rows) => [...rows.filter((row) => row.automation.id !== id), saved])
        closeOn(saved)
      }
    )
  }
  const tabs = (
    <AutomationTabs
      selected={tab}
      onSelect={(next) => leaveThrough(props.leaveGuard, () => showList(next))}
      disabled={catalog.busy}
    />
  )
  const create = () => {
    createAttempt.reset()
    openEditor({})
  }
  const bar: AutomationHeaderBar = row
    ? automationDetailBar(row, allAutomations, {
        disabled,
        onEdit: () => edit(row),
        onRuns: () => allRuns(row.automation.id),
        onDelete: () => remove(row)
      })
    : view.kind === 'run'
      ? automationRunBar(history.selected ?? view.run, () => setView(view.back), toast.showToast)
      : view.kind === 'list'
        ? {
            trailing: (
              <AutomationNewButton disabled={disabled || !catalog.loaded} onPress={create} />
            )
          }
        : {}
  const runsTab = view.kind === 'list' && tab === 'runs'
  const loadFailed = !catalog.loaded && catalog.error !== null && view.kind === 'list'
  const notes = (
    <AutomationCatalogNotes
      connected={catalog.connected}
      error={catalog.error}
      failedLoad={loadFailed}
      onRetry={disabled ? null : () => void catalog.refresh(true)}
    />
  )
  return (
    <>
      {props.renderHeader ? props.renderHeader(tabs, bar) : tabs}
      {view.kind === 'run' ? (
        <AutomationRunDetails
          run={view.run}
          client={props.client}
          hostId={props.hostId}
          executionHost={props.executionHost}
          connected={catalog.connected}
          history={history}
          notes={notes}
          toast={toast.message}
          onBack={() => setView(view.back)}
        />
      ) : (
        <ScrollView
          style={styles.screen}
          contentContainerStyle={[
            styles.grouped,
            // The bar's height counts the bottom inset the screen already pads.
            runsTab && { paddingBottom: Math.max(runFilters.barHeight - insets.bottom, 0) }
          ]}
          keyboardShouldPersistTaps="handled"
        >
          {notes}
          {row ? (
            <>
              <AutomationDetail
                row={row}
                onBack={allAutomations}
                client={props.client}
                disabled={disabled}
                projectName={projectName(row.automation)}
                onToggle={(enabled) => toggle(row, enabled)}
                onEdit={(section) => edit(row, section)}
              />
              <AutomationRecentRuns
                history={history}
                connected={catalog.connected}
                onSelect={(run) => setView({ kind: 'run', run, scope: historyScope, back: view })}
              />
            </>
          ) : null}
          {view.kind === 'list' && tab === 'automations' && !loadFailed ? (
            <AutomationList
              rows={catalog.rows}
              loaded={catalog.loaded}
              disabled={disabled}
              projectName={projectName}
              onCreate={create}
              onOpen={(selected) => setView({ kind: 'detail', row: selected })}
              onToggle={toggle}
            />
          ) : null}
          {view.kind === 'list' && tab === 'runs' && !loadFailed ? (
            <AutomationRunsView
              query={runFilters.query}
              outcome={runFilters.outcome}
              history={history}
              connected={catalog.connected}
              onSelect={(run) => setView({ kind: 'run', run, scope: historyScope, back: view })}
            />
          ) : null}
        </ScrollView>
      )}
      {runsTab && !loadFailed ? (
        <AutomationRunsBar filters={runFilters} rows={catalog.rows} />
      ) : null}
      {row ? (
        <AutomationRunNowBar
          disabled={disabled || row.item.selector.kind === 'orphan'}
          onRun={() => runNow(row)}
        />
      ) : null}
      <AutomationEditorSheet
        request={editor}
        open={editorOpen}
        client={props.client}
        hostId={props.hostId}
        executionHost={props.executionHost}
        catalog={catalog}
        leaveGuard={props.leaveGuard}
        onDraftChange={createAttempt.observeDraft}
        onClose={() => setEditorOpen(false)}
        onAfterClose={(key) => setEditor((current) => (current?.key === key ? null : current))}
        onSave={save}
        onBotSaved={(saved) => {
          catalog.setRows((rows) =>
            rows.map((entry) => (entry.automation.id === saved.automation.id ? saved : entry))
          )
          void catalog.refresh()
          closeOn(saved)
        }}
      >
        <OrcaHookTrustDrawer {...setupConsent.drawer} />
      </AutomationEditorSheet>
    </>
  )
}
