import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { printResult } from '../format'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import type { ExternalEditorResult } from '../../shared/external-editor'

/** External editor callers must wait for completed disk writes before re-reading their input. */
export const editFile: CommandHandler = async (ctx) => {
  // The SSH shim runs on the desktop, but its paths belong to the remote host.
  if (ctx.client.isRemote || process.env.ORCA_CLI_CWD) {
    throw new RuntimeClientError(
      'invalid_argument',
      'file edit requires a local desktop connection; SSH, WSL shims and paired runtimes are not supported.'
    )
  }
  const filePath = resolve(ctx.cwd, getRequiredStringFlag(ctx.flags, 'path'))
  const wait = ctx.flags.get('wait') === true
  const response = await ctx.client.call<ExternalEditorResult>(
    'files.edit',
    { filePath, wait },
    wait ? { timeoutMs: MAX_TIMER_DELAY_MS } : undefined
  )
  if (wait && response.result.closed !== true) {
    throw new RuntimeClientError(
      'runtime_unavailable',
      'The editor did not confirm that the file was closed.'
    )
  }
  if (wait) {
    await access(filePath)
  }
  printResult(
    response,
    ctx.json,
    (result) => `${result.closed ? 'Closed' : 'Opened'} ${result.filePath}.`
  )
}
