import { formatBrowserActionEffects } from '../browser/browser-format'
import { prepareComputerCliJsonResult } from '../computer/computer-format'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'

export function printResult<TResult>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  formatter: (value: TResult) => string,
  jsonReplacer?: (key: string, value: unknown) => unknown
): void {
  if (json) {
    // Agents pay per byte of --json output; people can pipe it through `jq .` to read it.
    console.log(JSON.stringify(prepareComputerCliJsonResult(response), jsonReplacer))
    return
  }
  console.log(formatter(response.result) + formatBrowserActionEffects(response.result))
}
