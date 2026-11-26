/** Why a send to a paired server's worker that is not running was refused; the bot eval's stand-in
 *  answers in the same words. */
export function pairedServerSendRefusal(
  dispatchId: string,
  server: string,
  state: string | undefined
): string {
  // Paired servers cannot continue a finished worker yet; steering a running one still works.
  return state && ['succeeded', 'failed', 'stopped', 'abandoned'].includes(state)
    ? `Dispatch ${dispatchId} finished on ${server}, which cannot take follow-ups for finished workers yet. Start a new worker there with \`orca orchestration worker-start --on ${server}\`.`
    : `Dispatch ${dispatchId} on ${server} is not confirmed running (${state ?? 'unknown'}), so this message was not sent. Check it with \`orca orchestration worker-show --dispatch ${dispatchId}\` before starting another worker.`
}
