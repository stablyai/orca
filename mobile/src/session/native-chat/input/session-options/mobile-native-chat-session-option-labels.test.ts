import { expect, it } from 'vitest'
import { translate } from '../../../../i18n/mobile-i18n'
import { AGENT_CHAT_PERMISSION_MODES } from '../../../../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'
import { structuredAgentSessionPermissionDescriptor } from '../../../../../../src/shared/agent-session/options/permissions/structured-agent-session-permission-option'
import { createStructuredAgentSessionOptionRecord } from '../../../../../../src/shared/agent-session/options/reconciliation/structured-agent-session-option-state'
import {
  mobileDeferredPermissionSummary,
  mobileReportedPermissionAccessibleValue,
  mobileSessionOptionSummaryValue
} from './mobile-native-chat-session-option-labels'

it('never shows or speaks the raw saved value of an Own permission choice', () => {
  const reports = [undefined, 'plan', 'read-only', ...AGENT_CHAT_PERMISSION_MODES]
  const running = [undefined, ...AGENT_CHAT_PERMISSION_MODES]
  for (const reportedPermissionMode of reports) {
    for (const runningPermissionMode of running) {
      // The host's own descriptor: Own is the saved value and is not among the listed choices.
      const descriptor = structuredAgentSessionPermissionDescriptor({
        record: createStructuredAgentSessionOptionRecord('claude'),
        permissionMode: 'own',
        permissionOwnSupported: true,
        reportedPermissionMode,
        ...(runningPermissionMode ? { runningPermissionMode } : {})
      })
      expect(descriptor).not.toBeNull()
      const deferred = mobileDeferredPermissionSummary(descriptor!, translate)
      const shown = [
        mobileSessionOptionSummaryValue(descriptor!, translate),
        mobileReportedPermissionAccessibleValue(descriptor!, translate),
        deferred?.saved,
        deferred?.full,
        deferred?.timing
      ]
      for (const text of shown.filter((value) => value !== undefined)) {
        expect(text, JSON.stringify({ reportedPermissionMode, runningPermissionMode })).not.toMatch(
          /\bown\b/i
        )
      }
    }
  }
})
