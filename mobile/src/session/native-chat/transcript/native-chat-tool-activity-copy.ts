import type { Translate } from '../../../i18n/mobile-i18n'

export function nativeChatToolCallCount(t: Translate, count: number): string {
  return count === 1
    ? t('chat.toolActivity.count_one', '{{count}} tool call', { count })
    : t('chat.toolActivity.count_other', '{{count}} tool calls', { count })
}

export function nativeChatToolActivityCopy(
  t: Translate,
  values?: { preview?: string; toolName?: string; value0?: number }
) {
  return {
    runningPreview: t('chat.toolActivity.runningPreview', 'Running {{preview}}', values),
    runningCommand: t('chat.toolActivity.runningCommand', 'Running command'),
    runningNamedPreview: t(
      'chat.toolActivity.runningNamedPreview',
      'Running {{toolName}} {{preview}}',
      values
    ),
    runningNamed: t('chat.toolActivity.runningNamed', 'Running {{toolName}}', values),
    result: t('chat.toolActivity.result', 'Result'),
    countOne: nativeChatToolCallCount(t, 1),
    countN: nativeChatToolCallCount(t, values?.value0 ?? 0),
    moreCalls: t('chat.toolActivity.moreCalls', '+{{value0}} more', values),
    failedCount: t('chat.toolActivity.failedCount', '{{value0}} failed', values),
    failedCallsLabel: t(
      'chat.toolActivity.failedCallsLabel',
      'Failed tool calls: {{value0}}',
      values
    ),
    interruptedCount: t('chat.toolActivity.interruptedCount', '{{value0}} interrupted', values),
    interruptedCallsLabel: t(
      'chat.toolActivity.interruptedCallsLabel',
      'Interrupted tool calls: {{value0}}',
      values
    )
  }
}
