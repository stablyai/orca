import { Agent } from 'undici'
import { getFirstPartyCaCertificates } from './first-party-tls-trust'

let nodeDispatcher: Agent | undefined

function getNodeDispatcher(): Agent {
  nodeDispatcher ??= new Agent({ connect: { ca: getFirstPartyCaCertificates() } })
  return nodeDispatcher
}

export async function firstPartyFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1]
): Promise<Response> {
  if (process.versions.electron && process.type === 'browser') {
    const { net } = await import('electron')
    return net.fetch(input instanceof URL ? input.toString() : input, init)
  }
  return globalThis.fetch(input, { ...init, dispatcher: getNodeDispatcher() } as RequestInit)
}
