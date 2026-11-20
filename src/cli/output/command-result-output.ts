import { isBrowserWithheldResult } from '../../shared/browser/runtime/browser-withheld-result'
import { formatBrowserActionEffects } from '../browser/browser-format'
import { prepareComputerCliJsonResult } from '../computer/computer-format'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'

export function printResult<TResult>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  formatter: (value: TResult) => string
): void {
  if (json) {
    console.log(JSON.stringify(prepareComputerCliJsonResult(response), null, 2))
    return
  }
  // A withheld page answers the same for every command; its own formatter would read nothing.
  if (isBrowserWithheldResult(response.result)) {
    console.log(response.result.message)
    return
  }
  console.log(formatter(response.result) + formatBrowserActionEffects(response.result))
}
