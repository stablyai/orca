import type {
  BackgroundTaskCopyId,
  BackgroundTaskSay
} from '../../../../../../src/shared/agent-status/presentation/background-tasks/background-task-copy'
import type { Translate } from '../../../../i18n/mobile-i18n'

export function mobileBackgroundTaskSay(t: Translate): BackgroundTaskSay {
  return (id, values) => {
    const count = values?.count
    const countValues = count === undefined ? undefined : { count }
    const phraseValues = values?.value0 === undefined ? undefined : { value0: values.value0 }
    const stateValues = { ...phraseValues, count }
    const copy = {
      monitoring: () => t('session.backgroundTask.monitoring', 'Monitoring background tasks'),
      stop: () => t('session.backgroundTask.stop', 'Stop'),
      stopTask: () => t('session.backgroundTask.stopTask', 'Stop {{value0}}', phraseValues),
      stopAll: () => t('session.backgroundTask.stopAll', 'Stop background tasks'),
      agent: () => t('session.backgroundTask.agent', 'Background agent'),
      workflow: () => t('session.backgroundTask.workflow', 'Background workflow'),
      command: () => t('session.backgroundTask.command', 'Background command'),
      monitor: () => t('session.backgroundTask.monitor', 'Background monitor'),
      task: () => t('session.backgroundTask.task', 'Background task'),
      detailsUnavailable: () =>
        t(
          'session.backgroundTask.detailsUnavailable',
          'Task details are unavailable for this session.'
        ),
      outputFile: () => t('session.backgroundTask.outputFile', 'Output: {{value0}}', phraseValues),
      countAgents: () =>
        count === 1
          ? t('session.backgroundTask.countAgents_one', '{{count}} agent', countValues)
          : t('session.backgroundTask.countAgents_other', '{{count}} agents', countValues),
      countShell: () =>
        count === 1
          ? t('session.backgroundTask.countShell_one', '{{count}} shell', countValues)
          : t('session.backgroundTask.countShell_other', '{{count}} shells', countValues),
      countShellCommandOne: () =>
        t('session.backgroundTask.countShellCommandOne', '1 shell command'),
      countMonitors: () =>
        count === 1
          ? t('session.backgroundTask.countMonitors_one', '{{count}} monitor', countValues)
          : t('session.backgroundTask.countMonitors_other', '{{count}} monitors', countValues),
      countWorkflows: () =>
        count === 1
          ? t('session.backgroundTask.countWorkflows_one', '{{count}} workflow', countValues)
          : t('session.backgroundTask.countWorkflows_other', '{{count}} workflows', countValues),
      countTasks: () =>
        count === 1
          ? t('session.backgroundTask.countTasks_one', '{{count}} task', countValues)
          : t('session.backgroundTask.countTasks_other', '{{count}} tasks', countValues),
      headerTotal: () =>
        count === 1
          ? t(
              'session.backgroundTask.headerTotalCount_one',
              '{{count}} background task',
              countValues
            )
          : t(
              'session.backgroundTask.headerTotalCount_other',
              '{{count}} background tasks',
              countValues
            ),
      stateWorking: () => t('session.backgroundTask.stateWorking', 'working'),
      stateWorkingCount: () =>
        count === 1
          ? t('session.backgroundTask.stateWorkingCount_one', '{{value0}} working', stateValues)
          : t('session.backgroundTask.stateWorkingCount_other', '{{value0}} working', stateValues),
      stateMonitoring: () => t('session.backgroundTask.stateMonitoring', 'monitoring'),
      stateMonitoringCount: () =>
        count === 1
          ? t(
              'session.backgroundTask.stateMonitoringCount_one',
              '{{value0}} monitoring',
              stateValues
            )
          : t(
              'session.backgroundTask.stateMonitoringCount_other',
              '{{value0}} monitoring',
              stateValues
            ),
      stateWaiting: () => t('session.backgroundTask.stateWaiting', 'waiting'),
      stateWaitingCount: () =>
        count === 1
          ? t('session.backgroundTask.stateWaitingCount_one', '{{value0}} waiting', stateValues)
          : t('session.backgroundTask.stateWaitingCount_other', '{{value0}} waiting', stateValues),
      stateBlocked: () => t('session.backgroundTask.stateBlocked', 'blocked'),
      stateBlockedCount: () =>
        count === 1
          ? t('session.backgroundTask.stateBlockedCount_one', '{{value0}} blocked', stateValues)
          : t('session.backgroundTask.stateBlockedCount_other', '{{value0}} blocked', stateValues),
      stateDone: () => t('session.backgroundTask.stateDone', 'done'),
      stateDoneCount: () =>
        count === 1
          ? t('session.backgroundTask.stateDoneCount_one', '{{value0}} done', stateValues)
          : t('session.backgroundTask.stateDoneCount_other', '{{value0}} done', stateValues),
      stateIdle: () => t('session.backgroundTask.stateIdle', 'stopped'),
      stateIdleCount: () =>
        count === 1
          ? t('session.backgroundTask.stateIdleCount_one', '{{value0}} stopped', stateValues)
          : t('session.backgroundTask.stateIdleCount_other', '{{value0}} stopped', stateValues),
      stateUnverifiable: () => t('session.backgroundTask.stateUnverifiable', 'status unavailable'),
      stateUnverifiableCount: () =>
        count === 1
          ? t(
              'session.backgroundTask.stateUnverifiableCount_one',
              '{{value0}} with status unavailable',
              stateValues
            )
          : t(
              'session.backgroundTask.stateUnverifiableCount_other',
              '{{value0}} with status unavailable',
              stateValues
            ),
      reasonWaiting: () => t('session.backgroundTask.reasonWaiting', 'needs approval'),
      reasonBlocked: () => t('session.backgroundTask.reasonBlocked', 'failed'),
      groupAgents: () => t('session.backgroundTask.groupAgents', 'Agents'),
      groupShell: () => t('session.backgroundTask.groupShell', 'Shell'),
      groupMonitors: () => t('session.backgroundTask.groupMonitors', 'Monitors'),
      groupWorkflows: () => t('session.backgroundTask.groupWorkflows', 'Workflows'),
      groupTasks: () => t('session.backgroundTask.groupTasks', 'Tasks')
    } satisfies Record<BackgroundTaskCopyId, () => string>
    return copy[id]()
  }
}
