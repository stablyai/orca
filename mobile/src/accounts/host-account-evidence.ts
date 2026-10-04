import type { RpcClient } from '../transport/rpc-client'

function createHostAccountEvidence(client: RpcClient) {
  let revision = 0
  let nextRead = 0
  let acceptedRead = 0
  const reads = new WeakMap<Promise<unknown>, ReturnType<typeof beginRead>>()

  function beginRead() {
    const startedRevision = revision
    const generation = client.getGeneration?.()
    const sequence = ++nextRead
    const isCurrent = () =>
      revision === startedRevision &&
      client.getGeneration?.() === generation &&
      sequence >= acceptedRead
    return {
      isCurrent,
      accept: () => {
        if (!isCurrent()) {
          return false
        }
        acceptedRead = sequence
        return true
      }
    }
  }

  return {
    retire: () => {
      revision += 1
    },
    read: (request: Promise<unknown>) => {
      // A shared in-flight reply keeps the evidence revision of its original request.
      const existing = reads.get(request)
      if (existing) {
        return existing
      }
      const read = beginRead()
      reads.set(request, read)
      return read
    }
  }
}

const evidenceByClient = new WeakMap<
  RpcClient,
  Map<string, ReturnType<typeof createHostAccountEvidence>>
>()

export function getHostAccountEvidence(client: RpcClient, hostId: string) {
  let hosts = evidenceByClient.get(client)
  if (!hosts) {
    hosts = new Map()
    evidenceByClient.set(client, hosts)
  }
  let evidence = hosts.get(hostId)
  if (!evidence) {
    evidence = createHostAccountEvidence(client)
    hosts.set(hostId, evidence)
  }
  return evidence
}
