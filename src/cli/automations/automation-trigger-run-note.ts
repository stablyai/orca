// trigger-options' last line: what a run gets, and where it answers for the sources listed.
import type { AutomationEventSource } from '../../shared/automation-event-triggers'

export function triggerRunNote(sources: readonly AutomationEventSource[]): string {
  return [
    'A run gets your prompt, then the event: its source, kind and time; for Slack, the channel id and message ts (and thread ts in a thread); then, quoted, who did it, where, a link and the text.',
    ...(sources.some((source) => source !== 'teams')
      ? [
          "With --results-to thread (the default when only these events start it), the run answers in the event's thread: `orca bot reply` posts there, and so does its final message."
        ]
      : []),
    ...(sources.includes('teams')
      ? ["Teams rules don't take --results-to thread: a Teams run answers with `orca teams post`."]
      : []),
    "`orca skills get orca-cli --reference automations` has each source's fields."
  ].join(' ')
}
