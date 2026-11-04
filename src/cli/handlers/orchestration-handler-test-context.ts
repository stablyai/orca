import { vi, type Mock } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClient } from '../runtime-client'

/** A handler context whose runtime calls go to `call`, to drive one command in a unit test. */
export function orchestrationTestContext(
  call: Mock,
  flags: Map<string, string | boolean>,
  json: boolean,
  cwd = '/tmp/repo'
): HandlerContext {
  const client = new RuntimeClient('/tmp/orca-orchestration-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(call)
  return { flags, client, cwd, json }
}
