import { registerClickUpHandlers } from '../clickup'
import { registerJiraHandlers } from '../jira/register-handlers'
import { registerLinearHandlers } from '../linear/register-handlers'

// Why: task-tracker providers register without app state, so grouping them
// keeps register-core-handlers.ts under its line budget as providers grow.
export function registerTaskTrackerHandlers(): void {
  registerLinearHandlers()
  registerClickUpHandlers()
  registerJiraHandlers()
}
