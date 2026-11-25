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
import { AutomationEditor } from './AutomationEditor'
import { leaveThrough, type AutomationLeaveSlot } from './AutomationEditorNavigation'
import { AutomationRecentRuns, AutomationRunsView } from './AutomationRunList'
import { AutomationPageBotEditor } from './AutomationPageBotEditor'
import { AutomationRunDetails } from './AutomationRunDetails'
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
import { automationEditorDraftKey, dropAutomationEditorDraft } from './automation-editor-draft-row'
import { automationStyles as styles } from './automation-styles'
import { useAutomationProjectNames } from './use-automation-project-names'

type AutomationView =
  | { kind: 'list' }
  | { kind: 'detail'; row: MobileAutomationRow }
  | { kind: 'editor'; row?: MobileAutomationRow; initialDraft?: AutomationDraft }
  | { kind: 'run'; run: MobileAutomationRun; scope: AutomationRunScope }
const ACTION_OPTIONS = { failWhenDisconnected: true }

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
  const startView: AutomationView = props.startInEditor ? { kind: 'editor' } : { kind: 'list' }
  const [view, setView] = useState<AutomationView>(startView)
  const [tab, setTab] = useState<'automations' | 'runs'>('automations')
  const [filter, setFilter] = useState<AutomationRunScope>(null)
  const [outcome, setOutcome] = useState('all')
  useStartOnAutomation(catalog, props.startOnAutomation, (row) => setView({ kind: 'detail', row }))
  const createAttempt = useAutomationCreateAttempt(
    catalog.rows,
    view.kind === 'editor' && !view.row,
    (saved, initialDraft) => {
      catalog.setError(null)
      setView(
        initialDraft ? { kind: 'editor', row: saved, initialDraft } : { kind: 'detail', row: saved }
      )
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
        : filter
  const history = useAutomationRuns(
    props.client,
    historyScope,
    catalog.revision,
    catalog.connected,
    view.kind === 'run' ? view.run : undefined,
    view.kind === 'detail' || view.kind === 'run' || (view.kind === 'list' && tab === 'runs')
  )
  function selectFilter(id: string) {
    const selected = catalog.rows.find((entry) => entry.automation.id === id)
    if (!id) {
      setFilter(null)
    } else if (selected) {
      setFilter({
        automationId: id,
        expectedOwner: toAutomationOwnerPrecondition(selected.item.selector)
      })
    }
  }
  function showList(next: 'automations' | 'runs') {
    setTab(next)
    setView({ kind: 'list' })
  }
  const allAutomations = () => showList('automations')
  function allRuns(automationId = '') {
    selectFilter(automationId)
    showList('runs')
  }
  function toggle(selected: MobileAutomationRow, enabled: boolean) {
    void catalog.perform(
      async (client) =>
        automationUpdateWrite.interpret(
          await automationUpdateWrite.request(
            client,
            {
              id: selected.automation.id,
              updates: { enabled },
              expectedOwner: toAutomationOwnerPrecondition(selected.item.selector)
            },
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
  function edit(selected: MobileAutomationRow) {
    void catalog.perform(
      async (client) =>
        automationShowRead.interpret(
          await automationShowRead.request(
            client,
            {
              id: selected.automation.id,
              expectedOwner: toAutomationOwnerPrecondition(selected.item.selector)
            },
            ACTION_OPTIONS
          )
        ),
      ({ automation }) => setView({ kind: 'editor', row: { ...selected, automation } })
    )
  }
  async function runNow(selected: MobileAutomationRow): Promise<boolean> {
    let accepted = false
    await catalog.perform(
      async (client) =>
        automationRunWrite.interpret(
          await automationRunWrite.request(
            client,
            {
              id: selected.automation.id,
              expectedOwner: toAutomationOwnerPrecondition(selected.item.selector)
            },
            ACTION_OPTIONS
          )
        ),
      ({ run }) => {
        accepted = true
        setTab('runs')
        setView({
          kind: 'run',
          run,
          scope: {
            automationId: selected.automation.id,
            expectedOwner: toAutomationOwnerPrecondition(selected.item.selector)
          }
        })
      }
    )
    return accepted
  }
  function remove(selected: MobileAutomationRow) {
    void catalog.perform(
      async (client) =>
        automationDeleteWrite.interpret(
          await automationDeleteWrite.request(
            client,
            {
              id: selected.automation.id,
              expectedOwner: toAutomationOwnerPrecondition(selected.item.selector)
            },
            ACTION_OPTIONS
          )
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
    const editing = view.kind === 'editor' ? view.row : undefined
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
        setView({ kind: 'detail', row: saved })
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
    setView({ kind: 'editor' })
  }
  const bar: AutomationHeaderBar = row
    ? automationDetailBar(row, allAutomations, {
        disabled,
        onEdit: () => edit(row),
        onRuns: () => allRuns(row.automation.id),
        onDelete: () => remove(row)
      })
    : view.kind === 'list'
      ? {
          trailing: <AutomationNewButton disabled={disabled || !catalog.loaded} onPress={create} />
        }
      : {}
  // Settings-style views lay out as grouped lists; the editor and a run keep their form spacing.
  const grouped = view.kind === 'list' || view.kind === 'detail'
  const loadFailed = !catalog.loaded && catalog.error !== null && view.kind === 'list'
  return (
    <>
      {props.renderHeader ? props.renderHeader(tabs, bar) : tabs}
      <ScrollView
        style={styles.screen}
        contentContainerStyle={grouped ? styles.grouped : styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <AutomationCatalogNotes
          connected={catalog.connected}
          error={catalog.error}
          failedLoad={loadFailed}
          onRetry={disabled ? null : () => void catalog.refresh(true)}
        />
        {view.kind === 'editor' && view.row?.automation.bot ? (
          <AutomationPageBotEditor
            row={view.row}
            client={props.client}
            hostId={props.hostId}
            executionHost={props.executionHost}
            connected={catalog.connected}
            leaveGuard={props.leaveGuard}
            onBack={(back) => setView({ kind: 'detail', row: back })}
            onSaved={(saved) => {
              catalog.setRows((rows) =>
                rows.map((entry) => (entry.automation.id === saved.automation.id ? saved : entry))
              )
              void catalog.refresh()
              setView({ kind: 'detail', row: saved })
            }}
          />
        ) : view.kind === 'editor' && props.client && catalog.loaded ? (
          <AutomationEditor
            key={view.row?.automation.id ?? 'create'}
            client={props.client}
            current={view.row?.automation}
            initialDraft={view.initialDraft}
            draftKey={automationEditorDraftKey(props.executionHost, view.row?.automation.id)}
            onDraftChange={createAttempt.observeDraft}
            leaveGuard={props.leaveGuard}
            capabilities={catalog.capabilities}
            busy={catalog.busy}
            connected={catalog.connected}
            onCancel={() =>
              view.row ? setView({ kind: 'detail', row: view.row }) : allAutomations()
            }
            onSave={save}
          />
        ) : null}
        {row ? (
          <>
            <AutomationDetail
              row={row}
              onBack={allAutomations}
              client={props.client}
              disabled={disabled}
              projectName={projectName(row.automation)}
              onToggle={(enabled) => toggle(row, enabled)}
            />
            <AutomationRecentRuns
              history={history}
              connected={catalog.connected}
              onSelect={(run) => {
                setTab('runs')
                setView({ kind: 'run', run, scope: historyScope })
              }}
            />
          </>
        ) : null}
        {view.kind === 'run' ? (
          <AutomationRunDetails
            run={view.run}
            client={props.client}
            hostId={props.hostId}
            executionHost={props.executionHost}
            connected={catalog.connected}
            history={history}
            onBack={() => showList('runs')}
          />
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
            rows={catalog.rows}
            automationId={filter?.automationId ?? ''}
            onAutomation={selectFilter}
            outcome={outcome}
            onOutcome={setOutcome}
            history={history}
            connected={catalog.connected}
            onSelect={(run) => setView({ kind: 'run', run, scope: historyScope })}
          />
        ) : null}
      </ScrollView>
      {row ? (
        <AutomationRunNowBar
          disabled={disabled || row.item.selector.kind === 'orphan'}
          onRun={() => runNow(row)}
        />
      ) : null}
      <OrcaHookTrustDrawer {...setupConsent.drawer} />
    </>
  )
}
