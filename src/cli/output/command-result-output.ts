import { formatBrowserActionEffects } from '../browser/browser-format'
import { prepareComputerCliJsonResult } from '../computer/computer-format'
import type { RuntimeRpcSuccess } from '../../shared/runtime-rpc-envelope'

export function printResult<TResult>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  formatter: (value: TResult) => string
): void {
  if (json) {
    console.log(JSON.stringify(prepareComputerCliJsonResult(response), null, 2))
    return
  }
  console.log(formatter(response.result) + formatBrowserActionEffects(response.result))
}
