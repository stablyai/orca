import type {
  BackgroundTaskCopyId,
  BackgroundTaskSay
} from '../../../src/shared/background-task-copy'
import { translate } from '../i18n/mobile-i18n'

export const sayMobileBackgroundTask: BackgroundTaskSay = (id, values) => {
  const count = values?.count
  const countValues = count === undefined ? undefined : { count }
  const phraseValues = values?.value0 === undefined ? undefined : { value0: values.value0 }
  const stateValues = { ...phraseValues, count }
  const copy = {
    monitoring: () => translate('session.backgroundTask.monitoring', 'Monitoring background tasks'),
    stop: () => translate('session.backgroundTask.stop', 'Stop'),
    stopTask: () => translate('session.backgroundTask.stopTask', 'Stop {{value0}}', phraseValues),
    stopAll: () => translate('session.backgroundTask.stopAll', 'Stop background tasks'),
    agent: () => translate('session.backgroundTask.agent', 'Background agent'),
    workflow: () => translate('session.backgroundTask.workflow', 'Background workflow'),
    command: () => translate('session.backgroundTask.command', 'Background command'),
    monitor: () => translate('session.backgroundTask.monitor', 'Background monitor'),
    task: () => translate('session.backgroundTask.task', 'Background task'),
    detailsUnavailable: () =>
      translate(
        'session.backgroundTask.detailsUnavailable',
        'Task details are unavailable for this session.'
      ),
    countAgents: () =>
      count === 1
        ? translate('session.backgroundTask.countAgents_one', '{{count}} agent', countValues)
        : translate('session.backgroundTask.countAgents_other', '{{count}} agents', countValues),
    countShell: () =>
      count === 1
        ? translate('session.backgroundTask.countShell_one', '{{count}} shell', countValues)
        : translate('session.backgroundTask.countShell_other', '{{count}} shells', countValues),
    countShellCommandOne: () =>
      translate('session.backgroundTask.countShellCommandOne', '1 shell command'),
    countMonitors: () =>
      count === 1
        ? translate('session.backgroundTask.countMonitors_one', '{{count}} monitor', countValues)
        : translate(
            'session.backgroundTask.countMonitors_other',
            '{{count}} monitors',
            countValues
          ),
    countWorkflows: () =>
      count === 1
        ? translate('session.backgroundTask.countWorkflows_one', '{{count}} workflow', countValues)
        : translate(
            'session.backgroundTask.countWorkflows_other',
            '{{count}} workflows',
            countValues
          ),
    countTasks: () =>
      count === 1
        ? translate('session.backgroundTask.countTasks_one', '{{count}} task', countValues)
        : translate('session.backgroundTask.countTasks_other', '{{count}} tasks', countValues),
    headerTotal: () =>
      count === 1
        ? translate(
            'session.backgroundTask.headerTotalCount_one',
            '{{count}} background task',
            countValues
          )
        : translate(
            'session.backgroundTask.headerTotalCount_other',
            '{{count}} background tasks',
            countValues
          ),
    stateWorking: () => translate('session.backgroundTask.stateWorking', 'working'),
    stateWorkingCount: () =>
      count === 1
        ? translate(
            'session.backgroundTask.stateWorkingCount_one',
            '{{value0}} working',
            stateValues
          )
        : translate(
            'session.backgroundTask.stateWorkingCount_other',
            '{{value0}} working',
            stateValues
          ),
    stateMonitoring: () => translate('session.backgroundTask.stateMonitoring', 'monitoring'),
    stateMonitoringCount: () =>
      count === 1
        ? translate(
            'session.backgroundTask.stateMonitoringCount_one',
            '{{value0}} monitoring',
            stateValues
          )
        : translate(
            'session.backgroundTask.stateMonitoringCount_other',
            '{{value0}} monitoring',
            stateValues
          ),
    stateWaiting: () => translate('session.backgroundTask.stateWaiting', 'waiting'),
    stateWaitingCount: () =>
      count === 1
        ? translate(
            'session.backgroundTask.stateWaitingCount_one',
            '{{value0}} waiting',
            stateValues
          )
        : translate(
            'session.backgroundTask.stateWaitingCount_other',
            '{{value0}} waiting',
            stateValues
          ),
    stateBlocked: () => translate('session.backgroundTask.stateBlocked', 'blocked'),
    stateBlockedCount: () =>
      count === 1
        ? translate(
            'session.backgroundTask.stateBlockedCount_one',
            '{{value0}} blocked',
            stateValues
          )
        : translate(
            'session.backgroundTask.stateBlockedCount_other',
            '{{value0}} blocked',
            stateValues
          ),
    stateDone: () => translate('session.backgroundTask.stateDone', 'done'),
    stateDoneCount: () =>
      count === 1
        ? translate('session.backgroundTask.stateDoneCount_one', '{{value0}} done', stateValues)
        : translate('session.backgroundTask.stateDoneCount_other', '{{value0}} done', stateValues),
    stateIdle: () => translate('session.backgroundTask.stateIdle', 'stopped'),
    stateIdleCount: () =>
      count === 1
        ? translate('session.backgroundTask.stateIdleCount_one', '{{value0}} stopped', stateValues)
        : translate(
            'session.backgroundTask.stateIdleCount_other',
            '{{value0}} stopped',
            stateValues
          ),
    stateUnverifiable: () =>
      translate('session.backgroundTask.stateUnverifiable', 'status unavailable'),
    stateUnverifiableCount: () =>
      count === 1
        ? translate(
            'session.backgroundTask.stateUnverifiableCount_one',
            '{{value0}} with status unavailable',
            stateValues
          )
        : translate(
            'session.backgroundTask.stateUnverifiableCount_other',
            '{{value0}} with status unavailable',
            stateValues
          ),
    reasonWaiting: () => translate('session.backgroundTask.reasonWaiting', 'needs approval'),
    reasonBlocked: () => translate('session.backgroundTask.reasonBlocked', 'failed'),
    groupAgents: () => translate('session.backgroundTask.groupAgents', 'Agents'),
    groupShell: () => translate('session.backgroundTask.groupShell', 'Shell'),
    groupMonitors: () => translate('session.backgroundTask.groupMonitors', 'Monitors'),
    groupWorkflows: () => translate('session.backgroundTask.groupWorkflows', 'Workflows'),
    groupTasks: () => translate('session.backgroundTask.groupTasks', 'Tasks')
  } satisfies Record<BackgroundTaskCopyId, () => string>
  return copy[id]()
}
