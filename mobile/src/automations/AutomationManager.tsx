import { useRef, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { toAutomationOwnerPrecondition } from '../../../src/shared/automation-owner-precondition'
import { AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../src/shared/automation-runtime-capabilities'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { ConfirmModal } from '../components/ConfirmModal'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import type { RpcClient } from '../transport/rpc-client'
import { AutomationButton, AutomationChoice } from './AutomationControls'
import { AutomationList } from './AutomationList'
import { AutomationDetail } from './AutomationDetail'
import { AutomationEditor } from './AutomationEditor'
import { AutomationRunList } from './AutomationRunList'
import { AutomationRunDetails } from './AutomationRunDetails'
import type { MobileAutomationRow, MobileAutomationRun } from './automation-reply-schema'
import {
  automationCreateWrite,
  automationDeleteWrite,
  automationRunWrite,
  automationShowRead,
  automationUpdateWrite
} from './automation-operations'
import {
  automationCreateParams,
  automationUpdateParams,
  type AutomationDraft
} from './automation-draft'
import type { AutomationTargets } from './automation-target-inventory'
import { useAutomationCatalog } from './use-automation-catalog'
import { automationStyles as styles } from './automation-styles'

type AutomationView =
  | { kind: 'list' }
  | { kind: 'detail'; row: MobileAutomationRow }
  | { kind: 'editor'; row?: MobileAutomationRow }
  | { kind: 'run'; run: MobileAutomationRun }
const ACTION_OPTIONS = { failWhenDisconnected: true }

export function AutomationManager(props: {
  client: RpcClient | null
  hostId: string
  executionHost?: ExecutionHostId
}) {
  const catalog = useAutomationCatalog(props.client, !!props.executionHost)
  const [view, setView] = useState<AutomationView>({ kind: 'list' })
  const [tab, setTab] = useState<'automations' | 'runs'>('automations')
  const [filterId, setFilterId] = useState('')
  const [outcome, setOutcome] = useState('all')
  const [deleting, setDeleting] = useState<MobileAutomationRow | null>(null)
  const creationKey = useRef('')
  const disabled = !catalog.connected || catalog.busy
  const row =
    view.kind === 'detail'
      ? (catalog.rows.find((entry) => entry.automation.id === view.row.automation.id) ?? view.row)
      : null
  function allAutomations() {
    setTab('automations')
    setView({ kind: 'list' })
  }
  function allRuns(automationId = '') {
    setFilterId(automationId)
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
        setView({ kind: 'run', run })
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
      async (client) => {
        if (editing) {
          const params = automationUpdateParams(editing.automation.id, draft, original, targets)
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
        const params = automationCreateParams(
          draft,
          targets,
          catalog.capabilities.includes(AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY)
            ? creationKey.current
            : undefined
        )
        const result = automationCreateWrite.interpret(
          await automationCreateWrite.request(client, params, ACTION_OPTIONS)
        )
        if (!params.destination) {
          throw new Error('Automation destination was not captured.')
        }
        return {
          automation: result.automation,
          item: { automationId: result.automation.id, selector: params.destination.selector }
        }
      },
      (saved) => {
        catalog.setRows((previous) => [
          ...previous.filter((entry) => entry.automation.id !== saved.automation.id),
          saved
        ])
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
            { value: 'automations', label: 'Automations' },
            { value: 'runs', label: 'Runs' }
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
            Reconnect to this host to refresh or make changes. Saved information remains available
            below.
          </Text>
        ) : null}
        {catalog.error ? (
          <View style={styles.stack}>
            <Text accessibilityRole="alert" style={styles.error}>
              {catalog.error}
            </Text>
            <AutomationButton
              label="Refresh"
              onPress={() => void catalog.refresh(true)}
              disabled={disabled}
            />
          </View>
        ) : null}
        {view.kind === 'editor' && props.client ? (
          <AutomationEditor
            client={props.client}
            current={view.row?.automation}
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
              disabled={disabled}
              onBack={allAutomations}
              onToggle={(enabled) => toggle(row, enabled)}
              onEdit={() => edit(row)}
              onRun={() => runNow(row)}
              onDelete={() => setDeleting(row)}
              onRuns={() => allRuns(row.automation.id)}
            />
            <Text style={styles.heading}>Recent runs</Text>
            <AutomationRunList
              client={props.client}
              connected={catalog.connected}
              revision={catalog.revision}
              filter={row}
              recent
              onSelect={(run) => {
                setTab('runs')
                setView({ kind: 'run', run })
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
            revision={catalog.revision}
            onBack={() => allRuns(filterId)}
          />
        ) : null}
        {view.kind === 'list' && tab === 'automations' ? (
          <AutomationList
            rows={catalog.rows}
            loaded={catalog.loaded}
            failed={!!catalog.error}
            disabled={disabled}
            onCreate={() => {
              creationKey.current = randomV4Uuid()
              setView({ kind: 'editor' })
            }}
            onOpen={(selected) => setView({ kind: 'detail', row: selected })}
            onToggle={toggle}
          />
        ) : null}
        {view.kind === 'list' && tab === 'runs' ? (
          <View style={styles.stack}>
            <AutomationChoice
              label="Automation"
              value={filterId}
              options={[
                { value: '', label: 'All automations' },
                ...catalog.rows.map((entry) => ({
                  value: entry.automation.id,
                  label: entry.automation.name
                }))
              ]}
              onSelect={setFilterId}
            />
            <AutomationChoice
              label="Outcome"
              value={outcome}
              options={[
                { value: 'all', label: 'All outcomes' },
                { value: 'active', label: 'In progress' },
                { value: 'completed', label: 'Completed' },
                { value: 'dispatch_failed', label: 'Could not start' },
                { value: 'skipped', label: 'Skipped' }
              ]}
              onSelect={setOutcome}
            />
            <AutomationRunList
              client={props.client}
              connected={catalog.connected}
              revision={catalog.revision}
              filter={catalog.rows.find((entry) => entry.automation.id === filterId) ?? null}
              automationId={filterId}
              outcome={outcome}
              onSelect={(run) => setView({ kind: 'run', run })}
            />
          </View>
        ) : null}
      </ScrollView>
      <ConfirmModal
        visible={deleting !== null}
        title="Delete automation?"
        message={`Delete “${deleting?.automation.name ?? ''}” and its retained runs?`}
        confirmLabel="Delete automation"
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            remove(deleting)
          }
        }}
      />
    </>
  )
}
