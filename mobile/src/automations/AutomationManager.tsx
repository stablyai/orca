import { useAutomationSetupConsent } from './use-automation-setup-consent'
import { SetupHookTrustDrawer } from '../components/SetupHookTrustDrawer'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useAutomationRuns, type AutomationRunScope } from './use-automation-runs'
import { useState } from 'react'
import { useAutomationCreateAttempt } from './use-automation-create-attempt'
import { ScrollView, Text, View } from 'react-native'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { toAutomationOwnerPrecondition } from '../../../src/shared/automation-owner-precondition'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { ConfirmModal } from '../components/ConfirmModal'
import type { RpcClient } from '../transport/rpc-client'
import { AutomationButton, AutomationChoice } from './AutomationControls'
import { AutomationList } from './AutomationList'
import { AutomationDetail } from './AutomationDetail'
import { AutomationEditor } from './AutomationEditor'
import { AutomationRunList } from './AutomationRunList'
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
import { useAutomationCatalog } from './use-automation-catalog'
import { automationStyles as styles } from './automation-styles'

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
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const catalog = useAutomationCatalog(props.client, !!props.executionHost)
  const [view, setView] = useState<AutomationView>({ kind: 'list' })
  const [tab, setTab] = useState<'automations' | 'runs'>('automations')
  const [filter, setFilter] = useState<AutomationRunScope>(null)
  const filterId = filter?.automationId ?? ''
  const [outcome, setOutcome] = useState('all')
  const [deleting, setDeleting] = useState<MobileAutomationRow | null>(null)
  const createAttempt = useAutomationCreateAttempt(
    catalog.rows,
    view.kind === 'editor' && !view.row,
    (saved, initialDraft) => {
      catalog.setError(null)
      setView(
        initialDraft ? { kind: 'editor', row: saved, initialDraft } : { kind: 'detail', row: saved }
      )
    },
    catalog.isCurrentSnapshot
  )
  const setupConsent = useAutomationSetupConsent(props.client, props.executionHost)
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
  function allAutomations() {
    setTab('automations')
    setView({ kind: 'list' })
  }
  function allRuns(automationId = '') {
    selectFilter(automationId)
    setTab('runs')
    setView({ kind: 'list' })
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
  function runNow(selected: MobileAutomationRow) {
    void catalog.perform(
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
        catalog.setRows((rows) => [...rows.filter((row) => row.automation.id !== id), saved])
        setView({ kind: 'detail', row: saved })
      }
    )
  }
  return (
    <>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <MobileSegmentedControl
          fill
          segments={[
            { value: 'automations', label: t('automations.mobile.automations', 'Automations') },
            { value: 'runs', label: t('automations.mobile.runs', 'Runs') }
          ]}
          selected={tab}
          onSelect={(next) => {
            setTab(next)
            setView({ kind: 'list' })
          }}
          disabled={catalog.busy}
        />
        {!catalog.connected ? (
          <Text style={styles.meta}>
            {t(
              'automations.mobile.reconnectToThisHostToRefreshOrMakeChangesSavedInformationRemainsAvailableBelow',
              'Reconnect to this host to refresh or make changes. Saved information remains available below.'
            )}
          </Text>
        ) : null}
        {catalog.error ? (
          <View style={styles.stack}>
            <Text accessibilityRole="alert" style={styles.error}>
              {catalog.error}
            </Text>
            <AutomationButton
              label={t('automations.mobile.refresh', 'Refresh')}
              onPress={() => void catalog.refresh(true)}
              disabled={disabled}
            />
          </View>
        ) : null}
        {view.kind === 'editor' && props.client ? (
          <AutomationEditor
            key={view.row?.automation.id ?? 'create'}
            client={props.client}
            current={view.row?.automation}
            initialDraft={view.initialDraft}
            onDraftChange={createAttempt.observeDraft}
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
              client={props.client}
              disabled={disabled}
              onBack={allAutomations}
              onToggle={(enabled) => toggle(row, enabled)}
              onEdit={() => edit(row)}
              onRun={() => runNow(row)}
              onDelete={() => setDeleting(row)}
              onRuns={() => allRuns(row.automation.id)}
            />
            <Text style={styles.heading}>{t('automations.mobile.recentRuns', 'Recent runs')}</Text>
            <AutomationRunList
              history={history}
              connected={catalog.connected}
              recent
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
            onBack={() => {
              setTab('runs')
              setView({ kind: 'list' })
            }}
          />
        ) : null}
        {view.kind === 'list' && tab === 'automations' ? (
          <AutomationList
            rows={catalog.rows}
            loaded={catalog.loaded}
            failed={!!catalog.error}
            disabled={disabled}
            onCreate={() => {
              createAttempt.reset()
              setView({ kind: 'editor' })
            }}
            onOpen={(selected) => setView({ kind: 'detail', row: selected })}
            onToggle={toggle}
          />
        ) : null}
        {view.kind === 'list' && tab === 'runs' ? (
          <View style={styles.stack}>
            <AutomationChoice
              label={t('automations.mobile.automation', 'Automation')}
              value={filterId}
              options={[
                { value: '', label: t('automations.mobile.allAutomations', 'All automations') },
                ...catalog.rows.map((entry) => ({
                  value: entry.automation.id,
                  label: entry.automation.name
                }))
              ]}
              onSelect={selectFilter}
            />
            <AutomationChoice
              label={t('automations.mobile.outcome', 'Outcome')}
              value={outcome}
              options={[
                { value: 'all', label: t('automations.mobile.allOutcomes', 'All outcomes') },
                { value: 'active', label: t('automations.mobile.inProgress', 'In progress') },
                { value: 'completed', label: t('automations.mobile.completed', 'Completed') },
                {
                  value: 'dispatch_failed',
                  label: t('automations.mobile.couldNotStart', 'Could not start')
                },
                { value: 'skipped', label: t('automations.mobile.skipped', 'Skipped') }
              ]}
              onSelect={setOutcome}
            />
            <AutomationRunList
              connected={catalog.connected}
              history={history}
              outcome={outcome}
              onSelect={(run) => setView({ kind: 'run', run, scope: historyScope })}
            />
          </View>
        ) : null}
      </ScrollView>
      <SetupHookTrustDrawer {...setupConsent.drawer} />
      <ConfirmModal
        visible={deleting !== null}
        title={t('automations.mobile.deleteAutomationTitle', 'Delete automation?')}
        message={t(
          'automations.mobile.deleteRetained',
          'Delete “{{name}}” and its retained runs?',
          { name: deleting?.automation.name ?? '' }
        )}
        confirmLabel={t('automations.mobile.deleteAutomation', 'Delete automation')}
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove(deleting)}
      />
    </>
  )
}
