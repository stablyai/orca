import type { Translate } from '../../../i18n/mobile-i18n'

export function nativeChatTaskListCopy(
  t: Translate,
  values?: { completed?: number; total?: number; task?: string }
) {
  return {
    title: t('chat.taskList.title', 'Tasks'),
    completed: t('chat.taskList.completed', 'Completed'),
    inProgress: t('chat.taskList.inProgress', 'In progress'),
    pending: t('chat.taskList.pending', 'Pending'),
    empty: t('chat.taskList.empty', 'No tasks'),
    progress: t('chat.taskList.progress', '{{completed}} of {{total}} tasks completed', values),
    added: t('chat.taskList.added', 'Added {{task}}', values),
    removed: t('chat.taskList.removed', 'Removed {{task}}', values),
    started: t('chat.taskList.started', 'Started {{task}}', values),
    finished: t('chat.taskList.finished', 'Completed {{task}}', values),
    reset: t('chat.taskList.reset', 'Marked pending: {{task}}', values),
    updated: t('chat.taskList.updated', 'Updated {{task}}', values),
    unchanged: t('chat.taskList.unchanged', 'Tasks unchanged'),
    showAll: t('chat.taskList.showAll', 'Full task list')
  }
}
