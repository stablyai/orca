import type {
  BackgroundTaskCopyId,
  BackgroundTaskSay
} from '../../../src/shared/background-task-copy'
import { translate } from '../i18n/mobile-i18n'

export const sayMobileBackgroundTask: BackgroundTaskSay = (id, values) => {
  const count = values?.count
  const countValues = count === undefined ? undefined : { count }
  const phraseValues = values?.value0 === undefined ? undefined : { value0: values.value0 }
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
      translate('session.backgroundTask.stateWorkingCount', '{{value0}} working', phraseValues),
    stateMonitoring: () => translate('session.backgroundTask.stateMonitoring', 'monitoring'),
    stateMonitoringCount: () =>
      translate(
        'session.backgroundTask.stateMonitoringCount',
        '{{value0}} monitoring',
        phraseValues
      ),
    stateWaiting: () => translate('session.backgroundTask.stateWaiting', 'waiting'),
    stateWaitingCount: () =>
      translate('session.backgroundTask.stateWaitingCount', '{{value0}} waiting', phraseValues),
    stateBlocked: () => translate('session.backgroundTask.stateBlocked', 'blocked'),
    stateBlockedCount: () =>
      translate('session.backgroundTask.stateBlockedCount', '{{value0}} blocked', phraseValues),
    stateDone: () => translate('session.backgroundTask.stateDone', 'done'),
    stateDoneCount: () =>
      translate('session.backgroundTask.stateDoneCount', '{{value0}} done', phraseValues),
    stateIdle: () => translate('session.backgroundTask.stateIdle', 'stopped'),
    stateIdleCount: () =>
      translate('session.backgroundTask.stateIdleCount', '{{value0}} stopped', phraseValues),
    stateUnverifiable: () =>
      translate('session.backgroundTask.stateUnverifiable', 'status unavailable'),
    stateUnverifiableCount: () =>
      translate(
        'session.backgroundTask.stateUnverifiableCount',
        '{{value0}} with status unavailable',
        phraseValues
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
