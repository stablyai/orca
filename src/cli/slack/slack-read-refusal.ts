// Orca Cloud's words already say what to do (an Update link among them); a read's typed reason is added, never swapped in.
const READ_HINTS: Readonly<Record<string, string>> = {
  slack_thread_not_found:
    "Use the ref of the thread's root message; `orca slack read <channel>` lists current refs.",
  slack_channel_not_visible: "Check that the link is for this bot's Slack workspace."
}

const REASON = /^[a-z][a-z0-9_]{0,63}$/
const SCOPE = /^[a-z][\w:.,-]{0,127}$/

export function slackReadRefusalMessage(
  message: string,
  reason: string | undefined,
  scope: string | undefined
): string {
  if (!reason?.startsWith('slack_') || !REASON.test(reason)) {
    return message
  }
  const hint = READ_HINTS[reason]
  const needs = scope && SCOPE.test(scope) ? `, needs ${scope}` : ''
  return [message, hint, `(Slack reason: ${reason}${needs})`].filter(Boolean).join(' ')
}
