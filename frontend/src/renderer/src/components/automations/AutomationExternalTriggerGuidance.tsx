import React from 'react'
import { translate } from '@/i18n/i18n'

/** Why: read-only reference, not a form — HandleExternalTrigger has no
 *  production caller yet (TASK-BE-AUTO-009), so there is nothing here to
 *  configure, only the request shape a future caller needs to send. Field
 *  names match backend-go/proto/orca/automation/v1/automation.proto's
 *  HandleExternalTriggerRequest exactly. Split into its own file (rather
 *  than inline in AutomationSchedulePicker.tsx) to keep that file under
 *  AGENTS.md's max-lines limit. */
export function AutomationExternalTriggerGuidance(): React.JSX.Element {
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
      <p className="text-foreground">
        {translate(
          'auto.components.automations.AutomationExternalTriggerGuidance.ext001trig',
          'No schedule to configure — this automation only runs when an external caller invokes automation-service’s HandleExternalTrigger RPC. Orca does not call it automatically yet.'
        )}
      </p>
      <div>
        <div className="mb-1 font-medium text-foreground">
          {translate(
            'auto.components.automations.AutomationExternalTriggerGuidance.ext002shape',
            'Request shape (HandleExternalTriggerRequest)'
          )}
        </div>
        <pre className="overflow-x-auto rounded border border-border bg-muted/50 p-2 font-mono text-[11px] leading-5 text-foreground">
          {[
            '{',
            '  "automation_id": "<this automation’s id>",',
            '  "request_id":    "<caller-supplied idempotency key>",',
            '  "payload_json":  "<opaque JSON payload, passed through as-is>"',
            '}'
          ].join('\n')}
        </pre>
      </div>
    </div>
  )
}
