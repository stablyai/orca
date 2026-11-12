import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { resolveLaunchUserDataPath } from '../runtime/launch-user-data-path'
import { pluginDevWatchConfirmFor } from '../plugins/dev-watch/plugin-dev-watch-approval'

const RESET_WARNING =
  "This gives this machine's Orca server a new pairing key and installation id and removes every " +
  'paired device. Desktops and phones paired with it must pair again.'

export async function resetServeHostIdentity(userDataPath: string): Promise<void> {
  // Lazy: only this command needs orcad's lock code.
  const { resetHostIdentityUnderLock } =
    await import('../../main/orcad/orcad-host-identity-reset.js')
  const result = resetHostIdentityUnderLock(userDataPath)
  if (result.status === 'missing') {
    throw new RuntimeClientError('not_found', `No Orca data at ${userDataPath}; nothing to reset.`)
  }
  if (result.status === 'running') {
    throw new RuntimeClientError(
      'runtime_running',
      `Stop Orca (the desktop app or \`orca serve\`) for ${userDataPath} first. ${result.message}`
    )
  }
  if (result.status === 'failed') {
    throw new RuntimeClientError('reset_failed', `${result.message} Nothing was reset.`)
  }
  if (result.status === 'incomplete') {
    throw new RuntimeClientError(
      'reset_incomplete',
      `The reset did not finish (${result.message}). The next Orca start for ${userDataPath} finishes it before pairing is served; fix the cause first.`
    )
  }
}

export const SERVE_RESET_IDENTITY_HANDLERS: Record<string, CommandHandler> = {
  'serve reset-identity': async ({ flags, json }) => {
    const userDataPath = resolveLaunchUserDataPath()
    if (flags.get('yes') !== true) {
      const confirm = pluginDevWatchConfirmFor(json)
      if (!confirm) {
        throw new RuntimeClientError(
          'confirmation_required',
          `${RESET_WARNING} Run \`orca serve reset-identity --yes\` to continue.`
        )
      }
      if (!(await confirm(`${RESET_WARNING}\nReset ${userDataPath}? [y/N] `))) {
        console.log('Cancelled; nothing changed.')
        process.exitCode = 1
        return
      }
    }
    await resetServeHostIdentity(userDataPath)
    if (json) {
      console.log(JSON.stringify({ ok: true, result: { reset: true, userDataPath } }, null, 2))
      return
    }
    console.log(
      `Reset the pairing identity in ${userDataPath}. Start Orca again and pair clients with it.`
    )
  }
}
