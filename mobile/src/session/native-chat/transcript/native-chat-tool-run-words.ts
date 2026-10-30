import type { NativeChatToolRunSentenceWords } from '../../../../../src/shared/native-chat/tools/native-chat-tool-run-sentence'
import { getMobileUiLocale, type Translate } from '../../../i18n/mobile-i18n'
import { getUiIntlLocale } from '../../../i18n/ui-intl-locale'

export function nativeChatToolRunWords(t: Translate): NativeChatToolRunSentenceWords {
  return {
    continuation: (clause) =>
      ['en', 'es', 'fr', 'pt', 'ru', 'tr'].includes(getMobileUiLocale())
        ? `${clause.charAt(0).toLocaleLowerCase(getUiIntlLocale())}${clause.slice(1)}`
        : clause,
    clause: (category, count, live) => {
      const copy = live
        ? {
            read: () =>
              count === 1
                ? t('chat.toolRun.liveRead_one', 'Reading {{count}} file', { count })
                : t('chat.toolRun.liveRead_other', 'Reading {{count}} files', { count }),
            search: () =>
              count === 1
                ? t('chat.toolRun.liveSearch_one', 'Searching {{count}} time', { count })
                : t('chat.toolRun.liveSearch_other', 'Searching {{count}} times', { count }),
            listFiles: () =>
              count === 1
                ? t('chat.toolRun.liveListFiles_one', 'Listing {{count}} directory', { count })
                : t('chat.toolRun.liveListFiles_other', 'Listing {{count}} directories', { count }),
            unknown: () =>
              count === 1
                ? t('chat.toolRun.liveUnknown_one', 'Running {{count}} command', { count })
                : t('chat.toolRun.liveUnknown_other', 'Running {{count}} commands', { count }),
            fileChange: () =>
              count === 1
                ? t('chat.toolRun.liveFileChange_one', 'Editing {{count}} file', { count })
                : t('chat.toolRun.liveFileChange_other', 'Editing {{count}} files', { count }),
            webSearch: () =>
              count === 1
                ? t('chat.toolRun.liveWebSearch_one', 'Searching the web {{count}} time', { count })
                : t('chat.toolRun.liveWebSearch_other', 'Searching the web {{count}} times', {
                    count
                  }),
            browser: () =>
              count === 1
                ? t('chat.toolRun.liveBrowserOnce', 'Using the browser')
                : t('chat.toolRun.liveBrowserTimes_other', 'Using the browser {{count}} times', {
                    count
                  }),
            mcpToolCall: () =>
              count === 1
                ? t('chat.toolRun.liveMcpToolCall_one', 'Using {{count}} integration', { count })
                : t('chat.toolRun.liveMcpToolCall_other', 'Using {{count}} integrations', {
                    count
                  }),
            subAgentActivity: () =>
              count === 1
                ? t('chat.toolRun.liveSubAgentActivity_one', 'Running {{count}} agent', { count })
                : t('chat.toolRun.liveSubAgentActivity_other', 'Running {{count}} agents', {
                    count
                  }),
            todoList: () =>
              count === 1
                ? t('chat.toolRun.liveTodoListOnce', 'Updating the plan')
                : t('chat.toolRun.liveTodoListTimes_other', 'Updating the plan {{count}} times', {
                    count
                  }),
            other: () =>
              count === 1
                ? t('chat.toolRun.liveOther_one', 'Using {{count}} tool', { count })
                : t('chat.toolRun.liveOther_other', 'Using {{count}} tools', { count })
          }
        : {
            read: () =>
              count === 1
                ? t('chat.toolRun.settledRead_one', 'Read {{count}} file', { count })
                : t('chat.toolRun.settledRead_other', 'Read {{count}} files', { count }),
            search: () =>
              count === 1
                ? t('chat.toolRun.settledSearch_one', 'Searched {{count}} time', { count })
                : t('chat.toolRun.settledSearch_other', 'Searched {{count}} times', { count }),
            listFiles: () =>
              count === 1
                ? t('chat.toolRun.settledListFiles_one', 'Listed {{count}} directory', { count })
                : t('chat.toolRun.settledListFiles_other', 'Listed {{count}} directories', {
                    count
                  }),
            unknown: () =>
              count === 1
                ? t('chat.toolRun.settledUnknown_one', 'Ran {{count}} command', { count })
                : t('chat.toolRun.settledUnknown_other', 'Ran {{count}} commands', { count }),
            fileChange: () =>
              count === 1
                ? t('chat.toolRun.settledFileChange_one', 'Edited {{count}} file', { count })
                : t('chat.toolRun.settledFileChange_other', 'Edited {{count}} files', { count }),
            webSearch: () =>
              count === 1
                ? t('chat.toolRun.settledWebSearch_one', 'Searched the web {{count}} time', {
                    count
                  })
                : t('chat.toolRun.settledWebSearch_other', 'Searched the web {{count}} times', {
                    count
                  }),
            browser: () =>
              count === 1
                ? t('chat.toolRun.settledBrowserOnce', 'Used the browser')
                : t('chat.toolRun.settledBrowserTimes_other', 'Used the browser {{count}} times', {
                    count
                  }),
            mcpToolCall: () =>
              count === 1
                ? t('chat.toolRun.settledMcpToolCall_one', 'Used {{count}} integration', { count })
                : t('chat.toolRun.settledMcpToolCall_other', 'Used {{count}} integrations', {
                    count
                  }),
            subAgentActivity: () =>
              count === 1
                ? t('chat.toolRun.settledSubAgentActivity_one', 'Ran {{count}} agent', { count })
                : t('chat.toolRun.settledSubAgentActivity_other', 'Ran {{count}} agents', {
                    count
                  }),
            todoList: () =>
              count === 1
                ? t('chat.toolRun.settledTodoListOnce', 'Updated the plan')
                : t('chat.toolRun.settledTodoListTimes_other', 'Updated the plan {{count}} times', {
                    count
                  }),
            other: () =>
              count === 1
                ? t('chat.toolRun.settledOther_one', 'Used {{count}} tool', { count })
                : t('chat.toolRun.settledOther_other', 'Used {{count}} tools', { count })
          }
      return copy[category]()
    },
    pair: (value0, value1) =>
      t('chat.toolRun.pair', '{{value0}} and {{value1}}', { value0, value1 }),
    list: (leading, value1) =>
      t('chat.toolRun.list', '{{value0}}, and {{value1}}', {
        value0: leading.join(t('chat.toolRun.separator', ', ')),
        value1
      })
  }
}
