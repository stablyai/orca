// Orca Cloud's words already say what to do (an Update link among them); a read's typed reason is added, never swapped in.
const READ_HINTS: Readonly<Record<string, string>> = {
  slack_thread_not_found:
    "Use the ref of the thread's root message; `orca slack read <channel>` lists current refs.",
  slack_channel_not_visible: "Check that the channel or link is in this bot's Slack workspace."
}

const REASON = /^slack_[a-z0-9_]{1,58}$/
const SCOPE = /^[a-z][\w:.,-]{0,127}$/

export function slackReadRefusal(
  message: string,
  reason: string | undefined,
  scope: string | undefined
): { message: string; data?: { reason: string; scope?: string } } {
  if (!reason || !REASON.test(reason)) {
    return { message }
  }
  const needs = scope && SCOPE.test(scope) ? scope : undefined
  return {
    message: [
      message,
      READ_HINTS[reason],
      `(Slack reason: ${reason}${needs ? `, needs ${needs}` : ''})`
    ]
      .filter(Boolean)
      .join(' '),
    data: needs ? { reason, scope: needs } : { reason }
  }
}
